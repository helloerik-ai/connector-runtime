import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorRegistrationError, registerConnector } from '../src/index.js';

test('registers with the existing connector liveness protocol', async () => {
    let request: { url: string; method: string | undefined; headers: Headers; signal: AbortSignal | null | undefined } | undefined;
    const fetcher: typeof fetch = async (input, init) => {
        request = { url: String(input), method: init?.method, headers: new Headers(init?.headers), signal: init?.signal };
        return Response.json({ id: 'example' });
    };
    await registerConnector({ apiUrl: 'https://api.example/', connectorId: 'example', secret: 'registry-secret', fetcher });
    assert.equal(request?.url, 'https://api.example/api/connector/register');
    assert.equal(request?.method, 'POST');
    assert.equal(request?.headers.get('authorization'), 'Bearer registry-secret');
    assert.equal(request?.headers.get('x-erik-connector'), 'example');
    assert.equal(request?.headers.get('accept'), 'application/json');
    assert(request?.signal instanceof AbortSignal);
});

test('reports registration HTTP failures with a typed error', async () => {
    await assert.rejects(registerConnector({
        apiUrl: 'https://api.example', connectorId: 'example', secret: 'wrong',
        fetcher: async () => Response.json({ error: 'Invalid connector credential' }, { status: 401 }),
    }), (error: unknown) => error instanceof ConnectorRegistrationError && error.status === 401);
});
