import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { test } from 'node:test';
import {
    ERIK_BROWSER_RETURN_HEADER,
    PendingSetupLifecycle,
    PendingSetupLifecycleError,
    SealedSetupStateCodec,
    SealedSetupStateError,
    SetupRequestError,
    clearSetupCookieHeader,
    parseConnectorSetupRequest,
    parseSetupCookie,
    setupBrowserNonceMatches,
    setupCompletionHeaders,
    setupCookieHeader,
    setupCookieName,
    type ConnectorSetupRequest,
    type JsonValue,
    type SetupClaimContext,
} from '../src/index.js';

const nowMs = Date.parse('2026-11-17T12:00:00.000Z');
const now = () => nowMs;
const attempt = '123e4567-e89b-42d3-a456-426614174000';
const request: ConnectorSetupRequest = {
    orgId: 'org:a',
    connectionId: 'connection/1',
    setupAttempt: attempt,
    callSecret: 'call_secret_012345678901234567890123456789',
    returnToken: 'return_token_012345678901234567890123456789',
};
const claim: SetupClaimContext = {
    orgId: request.orgId,
    connectionId: request.connectionId,
    setupAttempt: request.setupAttempt,
    expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
};

function form(value: ConnectorSetupRequest = request): string {
    return new URLSearchParams(Object.entries(value)).toString();
}

test('strictly parses the exact bounded v2 setup form and optional installation secret', () => {
    const installationSecret = 'installation_012345678901234567890';
    assert.deepEqual(parseConnectorSetupRequest({
        contentType: 'Application/X-Www-Form-Urlencoded; charset=UTF-8',
        body: form({ ...request, installationSecret }),
    }), { ...request, installationSecret });
});

test('refuses unknown, missing, duplicate, malformed, overlong, and invalid setup fields', () => {
    const valid = form();
    for (const body of [
        `${valid}&extra=value`,
        valid.replace(/&returnToken=[^&]+/, ''),
        `${valid}&orgId=other`,
        `${valid}&bad=%ZZ`,
        `${valid}&broken`,
        valid.replace('org%3Aa', 'org%00a'),
        valid.replace(attempt, 'attempt-1'),
        valid.replace(request.returnToken, 'short'),
    ]) {
        assert.throws(() => parseConnectorSetupRequest({ contentType: 'application/x-www-form-urlencoded', body }),
            SetupRequestError);
    }
    assert.throws(() => parseConnectorSetupRequest({
        contentType: 'application/x-www-form-urlencoded',
        body: `orgId=${'x'.repeat(8 * 1024)}`,
    }), (error: unknown) => error instanceof SetupRequestError && error.code === 'too-large');
    assert.throws(() => parseConnectorSetupRequest({
        contentType: 'application/x-www-form-urlencoded',
        body: Uint8Array.from([0xff]),
    }), (error: unknown) => error instanceof SetupRequestError && error.code === 'malformed');
    for (const contentType of [undefined, ['application/x-www-form-urlencoded'], 'text/plain',
        'application/x-www-form-urlencoded; charset=latin1', 'application/x-www-form-urlencoded; charset=utf-8; x=y']) {
        assert.throws(() => parseConnectorSetupRequest({ contentType, body: valid }),
            (error: unknown) => error instanceof SetupRequestError && error.code === 'content-type');
    }
});

test('creates non-revealing bounded setup cookies and permits insecure cookies only on exact loopback HTTP', () => {
    const name = setupCookieName('drive_setup', attempt);
    assert.match(name, /^erik_setup_[a-f0-9]{24}$/);
    assert.equal(name.includes(attempt), false);
    assert.equal(name.includes('drive'), false);
    assert.equal(setupCookieHeader(name, request.returnToken, { path: '/oauth/callback', maxAgeSeconds: 600 }),
        `${name}=${request.returnToken}; Path=/oauth/callback; Max-Age=600; HttpOnly; SameSite=Lax; Secure`);
    assert.equal(setupCookieHeader(name, request.returnToken, {
        path: '/callback', maxAgeSeconds: 60, origin: 'http://127.0.0.1:3000',
    }).includes('; Secure'), false);
    assert.match(clearSetupCookieHeader(name, { path: '/oauth/callback' }),
        /Max-Age=0; HttpOnly; SameSite=Lax; Secure$/);
    for (const origin of ['http://connector.example', 'http://localhost.example', 'https://connector.example/path']) {
        assert.throws(() => setupCookieHeader(name, request.returnToken, {
            path: '/callback', maxAgeSeconds: 60, origin,
        }));
    }
    assert.throws(() => setupCookieHeader(name, request.returnToken, { path: '//callback', maxAgeSeconds: 3601 }));
    assert.match(setupCookieName('google-drive', attempt), /^erik_setup_[a-f0-9]{24}$/,
        'template connector ids are valid cookie namespaces');
});

test('compares browser nonces without accepting malformed values', () => {
    assert.equal(setupBrowserNonceMatches(request.returnToken, request.returnToken), true);
    assert.equal(setupBrowserNonceMatches(request.returnToken, `other_${'x'.repeat(32)}`), false);
    assert.equal(setupBrowserNonceMatches('short', 'short'), false);
    assert.equal(setupBrowserNonceMatches(request.returnToken, undefined), false);
});

test('strictly parses one opaque cookie and rejects ambiguity or duplicates', () => {
    const name = setupCookieName('example', attempt);
    assert.equal(parseSetupCookie(`session=ordinary.value; ${name}=${request.returnToken}`, name), request.returnToken);
    assert.equal(parseSetupCookie('session=ordinary.value', name), undefined);
    assert.equal(parseSetupCookie(undefined, name), undefined);
    for (const header of [
        `${name}=${request.returnToken}; ${name}=other_${'x'.repeat(32)}`,
        `session=a; session=b; ${name}=${request.returnToken}`,
        `${name}=short`,
        `${name}=${request.returnToken}=extra`,
        `broken; ${name}=${request.returnToken}`,
        [`${name}=${request.returnToken}`],
    ]) assert.throws(() => parseSetupCookie(header, name));
});

function tokens(): () => string {
    let value = 0;
    return () => `token_${String(value++).padStart(36, '0')}`;
}

test('creates state only from a matching live claim and bounds TTL by claim expiry', () => {
    const lifecycle = new PendingSetupLifecycle<JsonValue>({ now, token: tokens(), ttlMs: 60_000 });
    const pending = lifecycle.create({ claim, request, payload: { stage: 'provider' } });
    assert.deepEqual(pending.payload, { stage: 'provider' });
    assert.equal(pending.expiresAt.toISOString(), new Date(nowMs + 60_000).toISOString());
    assert.ok(pending.browserNonce);
    assert.throws(() => lifecycle.create({
        claim: { ...claim, connectionId: 'other' }, request, payload: null,
    }), (error: unknown) => error instanceof PendingSetupLifecycleError && error.code === 'invalid');
});

test('atomically replaces callback-pending state and permanently refuses a replayed attempt', () => {
    const lifecycle = new PendingSetupLifecycle<JsonValue>({ now, token: tokens() });
    const first = lifecycle.create({ claim, request, payload: 'first' });
    const secondRequest = { ...request, setupAttempt: '123e4567-e89b-42d3-a456-426614174001' };
    const secondClaim = { ...claim, setupAttempt: secondRequest.setupAttempt };
    const second = lifecycle.create({ claim: secondClaim, request: secondRequest, payload: 'second' });
    assert.throws(() => lifecycle.claim(first.state, first.browserNonce),
        (error: unknown) => error instanceof PendingSetupLifecycleError && error.code === 'expired');
    assert.equal(lifecycle.claim(second.state, second.browserNonce).payload, 'second');
    assert.throws(() => lifecycle.create({ claim, request, payload: 'replay' }),
        (error: unknown) => error instanceof PendingSetupLifecycleError && error.code === 'attempt-used');
});

test('allows local replacement after a continuation claims state because Erik is authoritative', async () => {
    const lifecycle = new PendingSetupLifecycle<JsonValue>({ now, token: tokens() });
    const pending = lifecycle.create({ claim, request, payload: { code: 'provider-code' } });
    const results = await Promise.allSettled([
        Promise.resolve().then(() => lifecycle.claim(pending.state, pending.browserNonce)),
        Promise.resolve().then(() => lifecycle.claim(pending.state, pending.browserNonce)),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected'
        && result.reason instanceof PendingSetupLifecycleError && result.reason.code === 'already-claimed').length, 1);
    const replacementRequest = { ...request, setupAttempt: '123e4567-e89b-42d3-a456-426614174002' };
    const replacement = lifecycle.create({
        claim: { ...claim, setupAttempt: replacementRequest.setupAttempt }, request: replacementRequest, payload: null,
    });
    assert.equal(lifecycle.claim(replacement.state, replacement.browserNonce).state, replacement.state);
    assert.throws(() => lifecycle.claim(pending.state, pending.browserNonce),
        (error: unknown) => error instanceof PendingSetupLifecycleError && error.code === 'expired');
});

test('checks browser nonces without consuming state and supports cookie-less provider callbacks', () => {
    const lifecycle = new PendingSetupLifecycle<JsonValue>({ now, token: tokens() });
    const browser = lifecycle.create({ claim, request, payload: null });
    assert.throws(() => lifecycle.claim(browser.state, `wrong_${'x'.repeat(32)}`),
        (error: unknown) => error instanceof PendingSetupLifecycleError && error.code === 'browser-mismatch');
    assert.equal(lifecycle.claim(browser.state, browser.browserNonce).state, browser.state);
    assert.equal(lifecycle.remove(browser.state), true);
    assert.equal(lifecycle.remove(browser.state), false);

    const nextRequest = { ...request, setupAttempt: '123e4567-e89b-42d3-a456-426614174003' };
    const provider = lifecycle.create({
        claim: { ...claim, setupAttempt: nextRequest.setupAttempt }, request: nextRequest,
        payload: { stage: 'woocommerce-callback' }, browserNonceRequired: false,
    });
    assert.equal(provider.browserNonce, undefined);
    assert.equal(lifecycle.claim(provider.state).state, provider.state);
});

test('re-arms claimed state for post-callback selection while preserving or changing browser binding', () => {
    const lifecycle = new PendingSetupLifecycle<JsonValue>({ now, token: tokens() });
    const pending = lifecycle.create({ claim, request, payload: { stage: 'authorization' } });
    lifecycle.claim(pending.state, pending.browserNonce);
    const selection = lifecycle.transition(pending.state, { stage: 'selection', drives: ['one'] });
    assert.equal(selection.browserNonce, pending.browserNonce);
    assert.deepEqual(lifecycle.claim(selection.state, selection.browserNonce).payload,
        { stage: 'selection', drives: ['one'] });
    const callback = lifecycle.transition(selection.state, { stage: 'provider-callback' }, { browserNonceRequired: false });
    assert.equal(callback.browserNonce, undefined);
    assert.equal(lifecycle.claim(callback.state).payload && true, true);
});

test('enforces capacity, provider payload bounds, expiry, and JSON-safe payloads', () => {
    let time = nowMs;
    const lifecycle = new PendingSetupLifecycle<JsonValue>({
        now: () => time, token: tokens(), capacity: 1, ttlMs: 1_000, maxPayloadBytes: 30,
    });
    const pending = lifecycle.create({ claim, request, payload: { safe: true }, browserNonceRequired: false });
    const otherRequest = { ...request, connectionId: 'other', setupAttempt: '123e4567-e89b-42d3-a456-426614174004' };
    assert.throws(() => lifecycle.create({
        claim: { ...claim, connectionId: 'other', setupAttempt: otherRequest.setupAttempt }, request: otherRequest, payload: null,
    }), (error: unknown) => error instanceof PendingSetupLifecycleError && error.code === 'capacity');
    assert.throws(() => lifecycle.transition(pending.state, { value: 'x'.repeat(100) }));
    time += 1_000;
    assert.throws(() => lifecycle.claim(pending.state),
        (error: unknown) => error instanceof PendingSetupLifecycleError && error.code === 'expired');
    const cyclic: { self?: JsonValue } = {};
    cyclic.self = cyclic as JsonValue;
    assert.throws(() => lifecycle.create({
        claim: { ...claim, connectionId: 'other', setupAttempt: otherRequest.setupAttempt }, request: otherRequest,
        payload: cyclic as JsonValue,
    }));
});

interface OAuthPayload extends Record<string, JsonValue> {
    stage: 'authorization' | 'selection';
    verifier?: string;
}

function validOAuthPayload(value: unknown): value is OAuthPayload {
    if (!value || Array.isArray(value) || typeof value !== 'object') return false;
    const found = value as Record<string, unknown>;
    const expected = found.stage === 'authorization' ? ['stage', 'verifier'] : ['stage'];
    return Object.keys(found).length === expected.length && expected.every(key => Object.hasOwn(found, key))
        && (found.stage === 'selection' || found.stage === 'authorization' && typeof found.verifier === 'string');
}

const key = Buffer.alloc(32, 7);

test('seals exact provider state with AES-256-GCM and restores capability context', () => {
    const codec = new SealedSetupStateCodec<OAuthPayload>({ key, now, validatePayload: validOAuthPayload });
    const browserNonce = 'browser_nonce_012345678901234567890123456';
    const token = codec.seal({
        claim, request, browserNonce, payload: { stage: 'authorization', verifier: 'verifier' },
    });
    assert.equal(token.includes(request.callSecret), false);
    assert.equal(token.includes(request.returnToken), false);
    assert.deepEqual(codec.open(token), {
        claim,
        callSecret: request.callSecret,
        returnToken: request.returnToken,
        browserNonce,
        payload: { stage: 'authorization', verifier: 'verifier' },
        issuedAt: new Date(nowMs),
        expiresAt: new Date(nowMs + 10 * 60_000),
    });
});

test('ties sealed expiry to the setup claim and retains the optional installation secret encrypted', () => {
    const shortClaim = { ...claim, expiresAt: new Date(nowMs + 30_000).toISOString() };
    const withInstallation = { ...request, installationSecret: 'installation_012345678901234567890' };
    const codec = new SealedSetupStateCodec<OAuthPayload>({ key, now, validatePayload: validOAuthPayload });
    const token = codec.seal({
        claim: shortClaim, request: withInstallation,
        browserNonce: 'browser_nonce_012345678901234567890123456', payload: { stage: 'selection' },
    });
    const opened = codec.open(token);
    assert.equal(opened.expiresAt.toISOString(), shortClaim.expiresAt);
    assert.equal(opened.installationSecret, withInstallation.installationSecret);
    assert.equal(token.includes(withInstallation.installationSecret), false);
});

function sealRaw(value: unknown): string {
    const iv = Buffer.alloc(12, 1);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from('erik-connector-setup-state-v1'));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

test('refuses tampering, wrong keys, expiry, unknown envelope fields, and invalid provider payload identically', () => {
    let time = nowMs;
    const codec = new SealedSetupStateCodec<OAuthPayload>({ key, now: () => time, validatePayload: validOAuthPayload });
    const token = codec.seal({
        claim, request, browserNonce: 'browser_nonce_012345678901234567890123456',
        payload: { stage: 'authorization', verifier: 'v' },
    });
    const failures = [
        token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'),
        token + '=',
        sealRaw({
            v: 1, claim, callSecret: request.callSecret, returnToken: request.returnToken, installationSecret: null,
            browserNonce: 'browser_nonce_012345678901234567890123456', payload: { stage: 'selection' },
            issuedAt: nowMs, expiresAt: nowMs + 1_000, extra: true,
        }),
        sealRaw({
            v: 1, claim, callSecret: request.callSecret, returnToken: request.returnToken, installationSecret: null,
            browserNonce: 'browser_nonce_012345678901234567890123456', payload: { stage: 'other' },
            issuedAt: nowMs, expiresAt: nowMs + 1_000,
        }),
    ];
    for (const invalid of failures) {
        assert.throws(() => codec.open(invalid),
            (error: unknown) => error instanceof SealedSetupStateError
                && error.message === 'Connector setup state is invalid or expired');
    }
    const wrongKey = new SealedSetupStateCodec<OAuthPayload>({ key: Buffer.alloc(32, 8), now, validatePayload: validOAuthPayload });
    assert.throws(() => wrongKey.open(token), SealedSetupStateError);
    time = nowMs + 10 * 60_000;
    assert.throws(() => codec.open(token), SealedSetupStateError);
});

test('emits only the opaque browser return and no-store completion headers', () => {
    assert.deepEqual(setupCompletionHeaders(request.returnToken), {
        [ERIK_BROWSER_RETURN_HEADER]: request.returnToken,
        'Cache-Control': 'no-store',
    });
    assert.throws(() => setupCompletionHeaders('https://app.example/return'));
});
