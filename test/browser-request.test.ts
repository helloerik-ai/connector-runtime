import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { test } from 'node:test';
import {
    CONNECTOR_BROWSER_HEADERS,
    ConnectorBrowserRequestError,
    signConnectorBrowserRequest,
    verifyConnectorBrowserRequest,
} from '../src/index.js';

const secret = 'browser_proxy_secret_0123456789abcdef';
const now = () => Date.parse('2026-11-16T12:00:00.000Z');
const request = {
    secret,
    connectorId: 'example',
    method: 'POST',
    path: '/erik/browser/setup',
    query: 'return=opaque%2Fvalue&x=1',
    body: '{"setup":"opaque"}',
    requestId: 'request-123',
    deadline: new Date('2026-11-16T12:00:30.000Z'),
    now,
};

test('signs the documented canonical browser request and verifies it with a deadline signal', () => {
    const signed = signConnectorBrowserRequest(request);
    const digest = 'a0228208931b54e4d4bc1083adb141dc1f7bf2f8231cf62ee847727a2c46116e';
    const canonical = [
        'example', 'POST', '/erik/browser/setup', 'return=opaque%2Fvalue&x=1', digest,
        'request-123', '2026-11-16T12:00:30.000Z',
    ].join('\n');
    assert.equal(signed.headers[CONNECTOR_BROWSER_HEADERS.bodySha256], digest);
    assert.equal(signed.headers[CONNECTOR_BROWSER_HEADERS.signature], createHmac('sha256', secret).update(canonical).digest('hex'));
    const verified = verifyConnectorBrowserRequest({ ...request, headers: signed.headers });
    assert.deepEqual({ ...verified, signal: undefined }, {
        connectorId: 'example', requestId: 'request-123', deadline: request.deadline,
        bodySha256: digest, signal: undefined,
    });
    assert.equal(verified.signal.aborted, false);
});

test('generates a unique request id and a bounded default deadline', () => {
    const { requestId: _requestId, deadline: _deadline, ...input } = request;
    const first = signConnectorBrowserRequest(input);
    const second = signConnectorBrowserRequest(input);
    assert.notEqual(first.requestId, second.requestId);
    assert.equal(first.deadline.toISOString(), '2026-11-16T12:00:30.000Z');
});

test('refuses substitution of every canonical signed field', () => {
    const signed = signConnectorBrowserRequest(request);
    const connectorHeaders = { ...signed.headers, [CONNECTOR_BROWSER_HEADERS.connectorId]: 'other' };
    assert.throws(() => verifyConnectorBrowserRequest({ ...request, connectorId: 'other', headers: connectorHeaders }),
        (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'bad-signature');
    for (const change of [
        { method: 'GET' },
        { path: '/erik/browser/other' },
        { query: 'return=other' },
    ]) {
        assert.throws(() => verifyConnectorBrowserRequest({ ...request, ...change, headers: signed.headers }),
            (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'bad-signature');
    }
    const changedBody = '{"setup":"other"}';
    const bodyHeaders = {
        ...signed.headers,
        [CONNECTOR_BROWSER_HEADERS.bodySha256]: createHash('sha256').update(changedBody).digest('hex'),
    };
    assert.throws(() => verifyConnectorBrowserRequest({ ...request, body: changedBody, headers: bodyHeaders }),
        (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'bad-signature');
    const changedRequest = { ...signed.headers, [CONNECTOR_BROWSER_HEADERS.requestId]: 'other-request' };
    assert.throws(() => verifyConnectorBrowserRequest({ ...request, headers: changedRequest }),
        (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'bad-signature');
    const changedDeadline = { ...signed.headers, [CONNECTOR_BROWSER_HEADERS.deadline]: '2026-11-16T12:00:29.000Z' };
    assert.throws(() => verifyConnectorBrowserRequest({ ...request, headers: changedDeadline }),
        (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'bad-signature');
});

test('refuses missing, empty, repeated and malformed browser authentication headers', () => {
    const signed = signConnectorBrowserRequest(request);
    for (const name of Object.values(CONNECTOR_BROWSER_HEADERS)) {
        const missing = { ...signed.headers, [name]: undefined };
        assert.throws(() => verifyConnectorBrowserRequest({ ...request, headers: missing }),
            (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'missing');
        const empty = { ...signed.headers, [name]: ' ' };
        assert.throws(() => verifyConnectorBrowserRequest({ ...request, headers: empty }), ConnectorBrowserRequestError);
        const repeated = { ...signed.headers, [name]: [signed.headers[name]!, signed.headers[name]!] };
        assert.throws(() => verifyConnectorBrowserRequest({ ...request, headers: repeated }),
            (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'multiple');
    }
    const duplicateCase = { ...signed.headers, 'x-erik-browser-request-id': 'other' };
    assert.throws(() => verifyConnectorBrowserRequest({ ...request, headers: duplicateCase }),
        (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'multiple');
    const combined = new Headers(signed.headers);
    combined.append(CONNECTOR_BROWSER_HEADERS.signature, signed.headers[CONNECTOR_BROWSER_HEADERS.signature]!);
    assert.throws(() => verifyConnectorBrowserRequest({ ...request, headers: combined }),
        (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'multiple');
});

test('returns exact errors for invalid, expired and unbounded browser deadlines', () => {
    for (const [deadline, code, status] of [
        ['invalid', 'invalid', 400],
        ['2026-11-16T12:00:00.000Z', 'expired', 408],
        ['2026-11-16T12:01:00.001Z', 'invalid', 400],
        ['2026-11-16T12:00:30Z', 'invalid', 400],
    ] as const) {
        const headers = { ...signConnectorBrowserRequest(request).headers, [CONNECTOR_BROWSER_HEADERS.deadline]: deadline };
        assert.throws(() => verifyConnectorBrowserRequest({ ...request, headers }),
            (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === code && error.status === status);
    }
    assert.throws(() => signConnectorBrowserRequest({ ...request, deadline: new Date('2026-11-16T12:01:00.001Z') }),
        (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'invalid' && error.status === 400);
    assert.throws(() => signConnectorBrowserRequest({ ...request, deadline: new Date('invalid') }),
        (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === 'invalid' && error.status === 400);
});

test('aborts the verified request signal at its deadline', async () => {
    const started = Date.now();
    const short = { ...request, deadline: new Date(started + 30), now: () => started };
    const signed = signConnectorBrowserRequest(short);
    const verified = verifyConnectorBrowserRequest({ ...short, headers: signed.headers });
    assert.equal(verified.signal.aborted, false);
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(verified.signal.aborted, true);
});

test('refuses unsafe or unbounded signer and verifier fields', () => {
    const validHeaders = signConnectorBrowserRequest(request).headers;
    const invalidInputs = [
        { secret: 'short' },
        { connectorId: 'Bad' },
        { method: 'post' },
        { path: '/erik/browser/setup/../other' },
        { path: '/erik/browser/setup%2Fother' },
        { query: `x=${'a'.repeat(8192)}` },
        { body: new Uint8Array(64 * 1024 + 1) },
    ];
    for (const change of invalidInputs) {
        assert.throws(() => signConnectorBrowserRequest({ ...request, ...change }), ConnectorBrowserRequestError);
        assert.throws(() => verifyConnectorBrowserRequest({ ...request, ...change, headers: validHeaders }), ConnectorBrowserRequestError);
    }
    for (const requestId of ['not valid', 'x'.repeat(201)]) {
        assert.throws(() => signConnectorBrowserRequest({ ...request, requestId }), ConnectorBrowserRequestError);
        assert.throws(() => verifyConnectorBrowserRequest({
            ...request, headers: { ...validHeaders, [CONNECTOR_BROWSER_HEADERS.requestId]: requestId },
        }), ConnectorBrowserRequestError);
    }
});

test('refuses malformed body digests and signatures before constant-time comparison', () => {
    const signed = signConnectorBrowserRequest(request);
    for (const [name, value, code] of [
        [CONNECTOR_BROWSER_HEADERS.bodySha256, '0'.repeat(63), 'body-mismatch'],
        [CONNECTOR_BROWSER_HEADERS.signature, '0'.repeat(63), 'bad-signature'],
        [CONNECTOR_BROWSER_HEADERS.signature, 'g'.repeat(64), 'bad-signature'],
    ] as const) {
        assert.throws(() => verifyConnectorBrowserRequest({
            ...request, headers: { ...signed.headers, [name]: value },
        }), (error: unknown) => error instanceof ConnectorBrowserRequestError && error.code === code);
    }
});
