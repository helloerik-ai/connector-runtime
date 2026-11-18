import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, } from 'node:crypto';
const MAX_SETUP_BODY_BYTES = 8 * 1024;
const MAX_LIFECYCLE_TTL_MS = 60 * 60_000;
const MAX_LIFECYCLE_CAPACITY = 10_000;
const MAX_PROVIDER_PAYLOAD_BYTES = 1024 * 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z0-9:._/-]+$/;
const OPAQUE = /^[A-Za-z0-9_-]+$/;
const COOKIE_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const COOKIE_VALUE = /^[\x21-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]+$/;
const STATE_AAD = Buffer.from('erik-connector-setup-state-v1', 'utf8');
export class SetupRequestError extends Error {
    code;
    constructor(code) {
        super('Invalid connector setup request');
        this.code = code;
        this.name = 'SetupRequestError';
    }
}
function validSetupRequest(value) {
    const expected = new Set(['orgId', 'connectionId', 'setupAttempt', 'callSecret', 'returnToken', 'installationSecret']);
    const required = ['orgId', 'connectionId', 'setupAttempt', 'callSecret', 'returnToken'];
    return Object.keys(value).every(key => expected.has(key))
        && required.every(key => Object.hasOwn(value, key))
        && typeof value.orgId === 'string' && value.orgId.length >= 1 && value.orgId.length <= 200
        && IDENTIFIER.test(value.orgId)
        && typeof value.connectionId === 'string' && value.connectionId.length >= 1 && value.connectionId.length <= 200
        && IDENTIFIER.test(value.connectionId)
        && typeof value.setupAttempt === 'string' && UUID_V4.test(value.setupAttempt)
        && typeof value.callSecret === 'string' && value.callSecret.length >= 20 && value.callSecret.length <= 500
        && OPAQUE.test(value.callSecret)
        && typeof value.returnToken === 'string' && value.returnToken.length >= 32 && value.returnToken.length <= 500
        && OPAQUE.test(value.returnToken)
        && (value.installationSecret === undefined
            || typeof value.installationSecret === 'string' && value.installationSecret.length >= 20
                && value.installationSecret.length <= 500 && OPAQUE.test(value.installationSecret));
}
function setupContentType(value) {
    if (typeof value !== 'string' || value.length > 100)
        throw new SetupRequestError('content-type');
    const parts = value.split(';').map(part => part.trim().toLowerCase());
    if (parts[0] !== 'application/x-www-form-urlencoded' || parts.length > 2
        || parts.length === 2 && parts[1] !== 'charset=utf-8')
        throw new SetupRequestError('content-type');
}
function decodeFormPart(value) {
    if (/%(?![0-9a-f]{2})/i.test(value))
        throw new SetupRequestError('malformed');
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    }
    catch {
        throw new SetupRequestError('malformed');
    }
}
/** Strictly parses Erik browser-contract v2 setup form fields. */
export function parseConnectorSetupRequest(input) {
    setupContentType(input.contentType);
    const bytes = typeof input.body === 'string' ? Buffer.from(input.body, 'utf8') : Buffer.from(input.body);
    if (bytes.length > MAX_SETUP_BODY_BYTES)
        throw new SetupRequestError('too-large');
    let body;
    try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        throw new SetupRequestError('malformed');
    }
    if (!body)
        throw new SetupRequestError('fields');
    const fields = Object.create(null);
    for (const pair of body.split('&')) {
        const separator = pair.indexOf('=');
        if (!pair || separator <= 0 || pair.indexOf('=', separator + 1) !== -1)
            throw new SetupRequestError('malformed');
        const name = decodeFormPart(pair.slice(0, separator));
        const value = decodeFormPart(pair.slice(separator + 1));
        if (Object.hasOwn(fields, name))
            throw new SetupRequestError('fields');
        fields[name] = value;
    }
    if (!validSetupRequest(fields))
        throw new SetupRequestError('fields');
    return { ...fields };
}
export function randomSetupToken(bytes = 32) {
    if (!Number.isSafeInteger(bytes) || bytes < 24 || bytes > 64)
        throw new Error('Setup token size must be between 24 and 64 bytes');
    return randomBytes(bytes).toString('base64url');
}
/** Derives a non-revealing, attempt- or state-specific cookie name. */
export function setupCookieName(namespace, discriminator) {
    if (!/^[a-z][a-z0-9_-]{0,49}$/.test(namespace) || !discriminator || discriminator.length > 16 * 1024) {
        throw new Error('Invalid setup cookie input');
    }
    const suffix = createHash('sha256').update(namespace, 'utf8').update('\0').update(discriminator, 'utf8').digest('hex').slice(0, 24);
    return `erik_setup_${suffix}`;
}
function cookieSecure(origin) {
    if (origin === undefined)
        return true;
    let parsed;
    try {
        parsed = new URL(origin);
    }
    catch {
        throw new Error('Invalid setup cookie origin');
    }
    if (parsed.origin !== origin || parsed.username || parsed.password || (parsed.pathname !== '/' && parsed.pathname !== '')
        || parsed.search || parsed.hash)
        throw new Error('Invalid setup cookie origin');
    if (parsed.protocol === 'https:')
        return true;
    if (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
        return false;
    throw new Error('Setup cookies require HTTPS except on loopback');
}
function cookieAttributes(options) {
    if (!/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]*$/.test(options.path) || options.path.length > 200
        || !Number.isSafeInteger(options.maxAgeSeconds) || options.maxAgeSeconds < 0 || options.maxAgeSeconds > 3600) {
        throw new Error('Invalid setup cookie options');
    }
    return `Path=${options.path}; Max-Age=${options.maxAgeSeconds}; HttpOnly; SameSite=Lax${cookieSecure(options.origin) ? '; Secure' : ''}`;
}
export function setupCookieHeader(name, value, options) {
    if (!COOKIE_NAME.test(name) || name.length > 100 || !OPAQUE.test(value) || value.length < 32 || value.length > 500) {
        throw new Error('Invalid setup cookie');
    }
    return `${name}=${value}; ${cookieAttributes(options)}`;
}
export function clearSetupCookieHeader(name, options) {
    if (!COOKIE_NAME.test(name) || name.length > 100)
        throw new Error('Invalid setup cookie');
    return `${name}=; ${cookieAttributes({ ...options, maxAgeSeconds: 0 })}`;
}
/** Returns one unambiguous opaque cookie value and rejects malformed or duplicate cookie headers. */
export function parseSetupCookie(header, name) {
    if (!COOKIE_NAME.test(name) || typeof header !== 'string' || header.length > 8 * 1024) {
        if (header === undefined)
            return undefined;
        throw new Error('Invalid setup cookie header');
    }
    const found = new Map();
    for (const part of header.split(';')) {
        const item = part.trim();
        const separator = item.indexOf('=');
        if (!item || separator <= 0 || item.indexOf('=', separator + 1) !== -1)
            throw new Error('Invalid setup cookie header');
        const cookieName = item.slice(0, separator);
        const value = item.slice(separator + 1);
        if (!COOKIE_NAME.test(cookieName) || found.has(cookieName) || value && !COOKIE_VALUE.test(value)) {
            throw new Error('Invalid setup cookie header');
        }
        found.set(cookieName, value);
    }
    const value = found.get(name);
    if (value === undefined)
        return undefined;
    if (!OPAQUE.test(value) || value.length < 32 || value.length > 500)
        throw new Error('Invalid setup cookie header');
    return value;
}
function jsonSize(value, maximum) {
    let encoded;
    try {
        encoded = JSON.stringify(value);
    }
    catch {
        throw new Error('Provider payload must be JSON-safe');
    }
    if (encoded === undefined)
        throw new Error('Provider payload must be JSON-safe');
    const parsed = JSON.parse(encoded);
    if (!jsonSafeEqual(value, parsed, 0))
        throw new Error('Provider payload must be JSON-safe');
    const bytes = Buffer.byteLength(encoded);
    if (bytes > maximum)
        throw new Error('Provider payload is too large');
    return { value: parsed, bytes };
}
function jsonSafeEqual(value, parsed, depth) {
    if (depth > 32)
        return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean')
        return value === parsed;
    if (typeof value === 'number')
        return Number.isFinite(value) && value === parsed;
    if (Array.isArray(value)) {
        return Array.isArray(parsed) && value.length === parsed.length
            && value.every((item, index) => jsonSafeEqual(item, parsed[index], depth + 1));
    }
    if (!value || typeof value !== 'object' || Array.isArray(parsed))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    const source = value;
    const keys = Object.keys(source);
    return parsed !== null && typeof parsed === 'object' && keys.length === Object.keys(parsed).length
        && keys.every(key => Object.hasOwn(parsed, key) && jsonSafeEqual(source[key], parsed[key], depth + 1));
}
function claimExpiry(claim) {
    const expected = ['orgId', 'connectionId', 'setupAttempt', 'expiresAt'];
    if (Object.keys(claim).length !== expected.length || expected.some(key => !Object.hasOwn(claim, key))
        || typeof claim.orgId !== 'string' || !claim.orgId || typeof claim.connectionId !== 'string' || !claim.connectionId
        || typeof claim.setupAttempt !== 'string' || !claim.setupAttempt || typeof claim.expiresAt !== 'string')
        return Number.NaN;
    const expiresAt = new Date(claim.expiresAt);
    return Number.isFinite(expiresAt.getTime()) && expiresAt.toISOString() === claim.expiresAt ? expiresAt.getTime() : Number.NaN;
}
function matchingSetup(claim, request) {
    return claim.orgId === request.orgId && claim.connectionId === request.connectionId
        && claim.setupAttempt === request.setupAttempt;
}
export class PendingSetupLifecycleError extends Error {
    code;
    constructor(code) {
        super('Connector setup continuation is invalid or expired');
        this.code = code;
        this.name = 'PendingSetupLifecycleError';
    }
}
export class PendingSetupLifecycle {
    #entries = new Map();
    #current = new Map();
    #attempts = new Map();
    #capacity;
    #ttlMs;
    #maxPayloadBytes;
    #now;
    #token;
    constructor(options = {}) {
        this.#capacity = options.capacity ?? 128;
        this.#ttlMs = options.ttlMs ?? 10 * 60_000;
        this.#maxPayloadBytes = options.maxPayloadBytes ?? 512 * 1024;
        this.#now = options.now ?? Date.now;
        this.#token = options.token ?? randomSetupToken;
        if (!Number.isSafeInteger(this.#capacity) || this.#capacity < 1 || this.#capacity > MAX_LIFECYCLE_CAPACITY
            || !Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > MAX_LIFECYCLE_TTL_MS
            || !Number.isSafeInteger(this.#maxPayloadBytes) || this.#maxPayloadBytes < 1
            || this.#maxPayloadBytes > MAX_PROVIDER_PAYLOAD_BYTES)
            throw new Error('Invalid pending setup lifecycle options');
    }
    create(input) {
        const now = this.#now();
        this.prune(now);
        const expiresAt = Math.min(claimExpiry(input.claim), now + this.#ttlMs);
        if (!matchingSetup(input.claim, input.request) || !Number.isFinite(expiresAt) || expiresAt <= now) {
            throw new PendingSetupLifecycleError('invalid');
        }
        if (this.#attempts.has(input.claim.setupAttempt))
            throw new PendingSetupLifecycleError('attempt-used');
        const scope = this.scope(input.claim);
        const previousState = this.#current.get(scope);
        const previous = previousState === undefined ? undefined : this.#entries.get(previousState);
        if (this.#entries.size - (previous ? 1 : 0) >= this.#capacity)
            throw new PendingSetupLifecycleError('capacity');
        const payload = jsonSize(input.payload, this.#maxPayloadBytes).value;
        const state = this.uniqueToken();
        const browserNonce = input.browserNonceRequired === false ? undefined : this.uniqueToken(new Set([state]));
        const entry = {
            state,
            claim: { ...input.claim },
            request: { ...input.request },
            payload,
            ...(browserNonce && { browserNonce }),
            expiresAt: new Date(expiresAt),
            status: 'pending',
        };
        if (previous)
            this.deleteEntry(previous);
        this.#entries.set(state, entry);
        this.#current.set(scope, state);
        this.#attempts.set(input.claim.setupAttempt, expiresAt);
        return this.publicEntry(entry);
    }
    claim(state, browserNonce) {
        const entry = this.get(state);
        if (entry.status !== 'pending')
            throw new PendingSetupLifecycleError('already-claimed');
        if (entry.browserNonce !== undefined && !opaqueEqual(entry.browserNonce, browserNonce)) {
            throw new PendingSetupLifecycleError('browser-mismatch');
        }
        entry.status = 'claimed';
        return this.publicEntry(entry);
    }
    /** Re-arms a claimed multi-step flow with new provider payload and optional browser binding. */
    transition(state, payload, options = {}) {
        const entry = this.get(state);
        if (entry.status !== 'claimed')
            throw new PendingSetupLifecycleError('invalid');
        const nextPayload = jsonSize(payload, this.#maxPayloadBytes).value;
        let nextBrowserNonce;
        if (options.browserNonceRequired !== false && options.browserNonce !== undefined) {
            if (!OPAQUE.test(options.browserNonce) || options.browserNonce.length < 32 || options.browserNonce.length > 500) {
                throw new PendingSetupLifecycleError('invalid');
            }
            nextBrowserNonce = options.browserNonce;
        }
        else if (options.browserNonceRequired !== false) {
            nextBrowserNonce = entry.browserNonce ?? this.uniqueToken(new Set([entry.state]));
        }
        entry.payload = nextPayload;
        entry.status = 'pending';
        if (nextBrowserNonce === undefined)
            delete entry.browserNonce;
        else
            entry.browserNonce = nextBrowserNonce;
        return this.publicEntry(entry);
    }
    remove(state) {
        if (!OPAQUE.test(state) || state.length < 32 || state.length > 500)
            return false;
        const entry = this.#entries.get(state);
        if (!entry)
            return false;
        this.deleteEntry(entry);
        return true;
    }
    get(state) {
        if (!OPAQUE.test(state) || state.length < 32 || state.length > 500)
            throw new PendingSetupLifecycleError('invalid');
        this.prune(this.#now());
        const entry = this.#entries.get(state);
        if (!entry)
            throw new PendingSetupLifecycleError('expired');
        return entry;
    }
    prune(now) {
        for (const entry of this.#entries.values()) {
            if (entry.expiresAt.getTime() <= now)
                this.deleteEntry(entry);
        }
        for (const [attempt, expiresAt] of this.#attempts) {
            if (expiresAt <= now)
                this.#attempts.delete(attempt);
        }
    }
    deleteEntry(entry) {
        this.#entries.delete(entry.state);
        const scope = this.scope(entry.claim);
        if (this.#current.get(scope) === entry.state)
            this.#current.delete(scope);
    }
    uniqueToken(excluded = new Set()) {
        for (let attempt = 0; attempt < 10; attempt += 1) {
            const token = this.#token();
            if (OPAQUE.test(token) && token.length >= 32 && token.length <= 500
                && !this.#entries.has(token) && !excluded.has(token))
                return token;
        }
        throw new Error('Could not create a unique setup token');
    }
    scope(claim) {
        return `${claim.orgId.length}:${claim.orgId}${claim.connectionId}`;
    }
    publicEntry(entry) {
        return {
            state: entry.state,
            claim: { ...entry.claim },
            request: { ...entry.request },
            payload: structuredClone(entry.payload),
            ...(entry.browserNonce && { browserNonce: entry.browserNonce }),
            expiresAt: new Date(entry.expiresAt),
        };
    }
}
function opaqueEqual(expected, supplied) {
    if (supplied === undefined || !OPAQUE.test(supplied) || supplied.length < 32 || supplied.length > 500)
        return false;
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(supplied, 'utf8');
    return left.length === right.length && timingSafeEqual(left, right);
}
export function setupBrowserNonceMatches(expected, supplied) {
    return OPAQUE.test(expected) && expected.length >= 32 && expected.length <= 500 && opaqueEqual(expected, supplied);
}
export class SealedSetupStateError extends Error {
    constructor() {
        super('Connector setup state is invalid or expired');
        this.name = 'SealedSetupStateError';
    }
}
export class SealedSetupStateCodec {
    #key;
    #validatePayload;
    #ttlMs;
    #maxTokenBytes;
    #maxPayloadBytes;
    #now;
    #random;
    constructor(options) {
        this.#key = Buffer.from(options.key);
        this.#validatePayload = options.validatePayload;
        this.#ttlMs = options.ttlMs ?? 10 * 60_000;
        this.#maxTokenBytes = options.maxTokenBytes ?? 16 * 1024;
        this.#maxPayloadBytes = options.maxPayloadBytes ?? 8 * 1024;
        this.#now = options.now ?? Date.now;
        this.#random = options.random ?? randomBytes;
        if (this.#key.length !== 32)
            throw new Error('Setup state key must be 32 bytes');
        if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1 || this.#ttlMs > MAX_LIFECYCLE_TTL_MS
            || !Number.isSafeInteger(this.#maxTokenBytes) || this.#maxTokenBytes < 128 || this.#maxTokenBytes > 64 * 1024
            || !Number.isSafeInteger(this.#maxPayloadBytes) || this.#maxPayloadBytes < 1
            || this.#maxPayloadBytes > MAX_PROVIDER_PAYLOAD_BYTES)
            throw new Error('Invalid sealed setup state options');
    }
    seal(input) {
        const now = this.#now();
        const claimExpiresAt = claimExpiry(input.claim);
        const expiresAt = Math.min(claimExpiresAt, now + this.#ttlMs);
        if (!matchingSetup(input.claim, input.request) || !Number.isFinite(expiresAt) || expiresAt <= now
            || !OPAQUE.test(input.browserNonce) || input.browserNonce.length < 32 || input.browserNonce.length > 500
            || !this.#validatePayload(input.payload))
            throw new SealedSetupStateError();
        const payload = jsonSize(input.payload, this.#maxPayloadBytes).value;
        const envelope = {
            v: 1,
            claim: { ...input.claim },
            callSecret: input.request.callSecret,
            returnToken: input.request.returnToken,
            installationSecret: input.request.installationSecret ?? null,
            browserNonce: input.browserNonce,
            payload,
            issuedAt: now,
            expiresAt,
        };
        const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8');
        const iv = Buffer.from(this.#random(12));
        if (iv.length !== 12)
            throw new Error('Setup state random source returned the wrong size');
        const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
        cipher.setAAD(STATE_AAD);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const token = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
        if (Buffer.byteLength(token) > this.#maxTokenBytes)
            throw new SealedSetupStateError();
        return token;
    }
    open(token) {
        try {
            if (!OPAQUE.test(token) || token.length < 39 || Buffer.byteLength(token) > this.#maxTokenBytes)
                throw new Error();
            const packed = Buffer.from(token, 'base64url');
            if (packed.length < 29 || packed.toString('base64url') !== token)
                throw new Error();
            const decipher = createDecipheriv('aes-256-gcm', this.#key, packed.subarray(0, 12));
            decipher.setAAD(STATE_AAD);
            decipher.setAuthTag(packed.subarray(12, 28));
            const plaintext = Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]);
            if (plaintext.length > this.#maxTokenBytes)
                throw new Error();
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
            if (!value || Array.isArray(value) || typeof value !== 'object')
                throw new Error();
            const envelope = value;
            const fields = ['v', 'claim', 'callSecret', 'returnToken', 'installationSecret', 'browserNonce', 'payload', 'issuedAt', 'expiresAt'];
            if (Object.keys(envelope).length !== fields.length || fields.some(field => !Object.hasOwn(envelope, field))
                || envelope.v !== 1 || !envelope.claim || Array.isArray(envelope.claim) || typeof envelope.claim !== 'object'
                || typeof envelope.callSecret !== 'string' || typeof envelope.returnToken !== 'string'
                || envelope.installationSecret !== null && typeof envelope.installationSecret !== 'string'
                || typeof envelope.browserNonce !== 'string' || !Number.isSafeInteger(envelope.issuedAt)
                || !Number.isSafeInteger(envelope.expiresAt) || !this.#validatePayload(envelope.payload))
                throw new Error();
            const claim = envelope.claim;
            const request = {
                orgId: claim.orgId,
                connectionId: claim.connectionId,
                setupAttempt: claim.setupAttempt,
                callSecret: envelope.callSecret,
                returnToken: envelope.returnToken,
                ...(typeof envelope.installationSecret === 'string' && { installationSecret: envelope.installationSecret }),
            };
            const claimExpiresAt = claimExpiry(claim);
            const now = this.#now();
            if (!validSetupRequest(request) || !Number.isFinite(claimExpiresAt)
                || envelope.issuedAt > now || envelope.issuedAt < now - this.#ttlMs
                || envelope.expiresAt <= now || envelope.expiresAt > claimExpiresAt
                || envelope.expiresAt > envelope.issuedAt + this.#ttlMs
                || !OPAQUE.test(envelope.browserNonce) || envelope.browserNonce.length < 32
                || envelope.browserNonce.length > 500)
                throw new Error();
            const payload = jsonSize(envelope.payload, this.#maxPayloadBytes).value;
            return {
                claim: { ...claim },
                callSecret: envelope.callSecret,
                returnToken: envelope.returnToken,
                ...(typeof envelope.installationSecret === 'string' && { installationSecret: envelope.installationSecret }),
                browserNonce: envelope.browserNonce,
                payload: payload,
                issuedAt: new Date(envelope.issuedAt),
                expiresAt: new Date(envelope.expiresAt),
            };
        }
        catch {
            throw new SealedSetupStateError();
        }
    }
}
export const ERIK_BROWSER_RETURN_HEADER = 'X-Erik-Browser-Return';
export function setupCompletionHeaders(returnToken) {
    if (!OPAQUE.test(returnToken) || returnToken.length < 32 || returnToken.length > 500) {
        throw new Error('Invalid browser return token');
    }
    return { [ERIK_BROWSER_RETURN_HEADER]: returnToken, 'Cache-Control': 'no-store' };
}
