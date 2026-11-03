import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorCallHeaderError, parseConnectorCallHeaders } from '../src/index.js';

const valid = {
    'x-erik-connector': 'example',
    'x-erik-org': 'org-a',
    'x-erik-connection': 'connection-1',
    'x-erik-call-secret': 'secret',
};

test('parses connector call headers case-insensitively', () => {
    assert.deepEqual(parseConnectorCallHeaders(valid, 'example'), {
        connectorId: 'example', orgId: 'org-a', connectionId: 'connection-1', callSecret: 'secret',
    });
    assert.deepEqual(parseConnectorCallHeaders(new Headers({
        'X-Erik-Connector': 'example',
        'X-Erik-Org': 'org-a',
        'X-Erik-Connection': 'connection-1',
        'X-Erik-Call-Secret': 'secret',
    }), 'example').connectionId, 'connection-1');
});

test('refuses wrong connector and every missing or empty authentication field', () => {
    assert.throws(() => parseConnectorCallHeaders(valid, 'other'),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'wrong-connector' && error.status === 401);
    for (const key of Object.keys(valid)) {
        const missing = { ...valid, [key]: undefined };
        assert.throws(() => parseConnectorCallHeaders(missing, 'example'),
            (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'missing');
        const empty = { ...valid, [key]: '   ' };
        assert.throws(() => parseConnectorCallHeaders(empty, 'example'),
            (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'empty');
    }
});

test('refuses arrays, duplicate casing and combined multi-valued headers', () => {
    assert.throws(() => parseConnectorCallHeaders({ ...valid, 'x-erik-org': ['org-a', 'org-b'] }, 'example'),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'multiple');
    assert.throws(() => parseConnectorCallHeaders({ ...valid, 'X-Erik-Org': 'org-b' }, 'example'),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'multiple');
    const headers = new Headers(valid);
    headers.append('X-Erik-Call-Secret', 'other');
    assert.throws(() => parseConnectorCallHeaders(headers, 'example'),
        (error: unknown) => error instanceof ConnectorCallHeaderError && error.code === 'multiple');
});
