import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorCallHeaderError, parseConnectorCallHeaders } from '../src/index.js';

const valid = {
    'x-erik-connector': 'example',
    'x-erik-org': 'org-a',
    'x-erik-connection': 'connection-1',
    'x-erik-call-secret': 'secret',
    'x-erik-invocation': 'call-123',
    'x-erik-deadline': '2026-11-04T12:00:30.000Z',
};
const now = () => Date.parse('2026-11-04T12:00:00.000Z');

test('parses connector call headers case-insensitively', () => {
    const parsed = parseConnectorCallHeaders(valid, 'example', { now });
    assert.deepEqual({ ...parsed, signal: undefined }, {
        connectorId: 'example', orgId: 'org-a', connectionId: 'connection-1', callSecret: 'secret',
        invocationId: 'call-123', deadline: new Date('2026-11-04T12:00:30.000Z'), signal: undefined,
    });
    assert.equal(parsed.signal.aborted, false);
    assert.deepEqual(parseConnectorCallHeaders(new Headers({
        'X-Erik-Connector': 'example',
        'X-Erik-Org': 'org-a',
        'X-Erik-Connection': 'connection-1',
        'X-Erik-Call-Secret': 'secret',
        'X-Erik-Invocation': 'call-123',
        'X-Erik-Deadline': '2026-11-04T12:00:30.000Z',
    }), 'example', { now }).connectionId, 'connection-1');
});

test('refuses wrong connector and every missing or empty authentication field', () => {
    assert.throws(() => parseConnectorCallHeaders(valid, 'other', { now }),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'wrong-connector' && error.status === 401);
    for (const key of Object.keys(valid)) {
        const missing = { ...valid, [key]: undefined };
        assert.throws(() => parseConnectorCallHeaders(missing, 'example', { now }),
            (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'missing');
        const empty = { ...valid, [key]: '   ' };
        assert.throws(() => parseConnectorCallHeaders(empty, 'example', { now }),
            (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'empty');
    }
});

test('refuses arrays, duplicate casing and combined multi-valued headers', () => {
    assert.throws(() => parseConnectorCallHeaders({ ...valid, 'x-erik-org': ['org-a', 'org-b'] }, 'example', { now }),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'multiple');
    assert.throws(() => parseConnectorCallHeaders({ ...valid, 'X-Erik-Org': 'org-b' }, 'example', { now }),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'multiple');
    const headers = new Headers(valid);
    headers.append('X-Erik-Call-Secret', 'other');
    assert.throws(() => parseConnectorCallHeaders(headers, 'example', { now }),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'multiple');
});

test('refuses malformed, expired and unbounded invocation deadlines', () => {
    assert.throws(() => parseConnectorCallHeaders({ ...valid, 'x-erik-deadline': 'soon' }, 'example', { now }),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'invalid' && error.status === 400);
    assert.throws(() => parseConnectorCallHeaders({ ...valid, 'x-erik-deadline': '2026-11-04T12:00:00.000Z' }, 'example', { now }),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'expired' && error.status === 408);
    assert.throws(() => parseConnectorCallHeaders({ ...valid, 'x-erik-deadline': '2026-11-04T12:02:00.000Z' }, 'example', { now }),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'invalid');
    assert.throws(() => parseConnectorCallHeaders({ ...valid, 'x-erik-invocation': 'not valid' }, 'example', { now }),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'invalid');
});
