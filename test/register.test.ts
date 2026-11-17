import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConnectorRegistrationError, registerConnector } from '../src/index.js';

const options = {
    apiUrl: 'https://api.example',
    connectorId: 'example',
    expectedDomain: 'example.helloerik.ai',
    secret: 'registry-secret',
};

test('registers without following redirects and binds the result to the configured domain', async () => {
    let request: {
        url: string;
        method: string | undefined;
        redirect: RequestRedirect | undefined;
        headers: Headers;
        signal: AbortSignal | null | undefined;
    } | undefined;
    const fetcher: typeof fetch = async (input, init) => {
        request = {
            url: String(input), method: init?.method, redirect: init?.redirect,
            headers: new Headers(init?.headers), signal: init?.signal,
        };
        return Response.json({
            id: 'example', domain: 'example.helloerik.ai', lastSeenAt: '2026-11-16T12:00:00.000Z',
            browserProxySecret: 'browser_proxy_secret_0123456789abcdef',
        });
    };
    const result = await registerConnector({ ...options, fetcher });
    assert.deepEqual(result, {
        id: 'example', domain: 'example.helloerik.ai', browserProxySecret: 'browser_proxy_secret_0123456789abcdef',
    });
    assert.equal(request?.url, 'https://api.example/api/connector/register');
    assert.equal(request?.method, 'POST');
    assert.equal(request?.redirect, 'error');
    assert.equal(request?.headers.get('authorization'), 'Bearer registry-secret');
    assert.equal(request?.headers.get('x-erik-connector'), 'example');
    assert.equal(request?.headers.get('accept'), 'application/json');
    assert(request?.signal instanceof AbortSignal);
});

test('refuses unsafe or noncanonical API origins and expected domains before network activity', async () => {
    const invalidApiUrls = [
        'http://api.example', 'https://api.example/', 'https://api.example/path', 'https://user@api.example',
        'https://*.example', 'https://api.example?x=1',
    ];
    const validLoopback = ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'];
    let calls = 0;
    const fetcher: typeof fetch = async () => {
        calls++;
        return Response.json({
            id: 'example', domain: options.expectedDomain,
            browserProxySecret: 'browser_proxy_secret_0123456789abcdef',
        });
    };
    for (const apiUrl of invalidApiUrls) {
        await assert.rejects(registerConnector({ ...options, apiUrl, fetcher }),
            (error: unknown) => error instanceof ConnectorRegistrationError && error.status === 400);
    }
    for (const expectedDomain of ['https://example.helloerik.ai', 'example.helloerik.ai/path', '*.helloerik.ai']) {
        await assert.rejects(registerConnector({ ...options, expectedDomain, fetcher }),
            (error: unknown) => error instanceof ConnectorRegistrationError && error.status === 400);
    }
    assert.equal(calls, 0);
    for (const apiUrl of validLoopback) await registerConnector({ ...options, apiUrl, fetcher });
    assert.equal(calls, validLoopback.length);
});

test('refuses malformed successful registration responses before accepting a browser credential', async () => {
    const cases: unknown[] = [
        null,
        { id: 'other', domain: 'example.helloerik.ai', browserProxySecret: 'browser_proxy_secret_0123456789abcdef' },
        { id: 'example', domain: 'https://example.helloerik.ai', browserProxySecret: 'browser_proxy_secret_0123456789abcdef' },
        { id: 'example', domain: 'example.helloerik.ai/path', browserProxySecret: 'browser_proxy_secret_0123456789abcdef' },
        { id: 'example', domain: 'example.helloerik.ai', browserProxySecret: 'short' },
        { id: 'example', domain: 'example.helloerik.ai', browserProxySecret: 'x'.repeat(513) },
        { id: 'example', domain: 'example.helloerik.ai', browserProxySecret: 'x'.repeat(32), extra: true },
    ];
    for (const value of cases) {
        await assert.rejects(registerConnector({
            ...options,
            fetcher: async () => Response.json(value),
        }), (error: unknown) => error instanceof ConnectorRegistrationError && error.status === 502);
    }
    await assert.rejects(registerConnector({
        ...options,
        fetcher: async () => new Response('{not json'),
    }), (error: unknown) => error instanceof ConnectorRegistrationError && error.status === 502);
    await assert.rejects(registerConnector({
        ...options,
        fetcher: async () => new Response(JSON.stringify({ value: 'x'.repeat(16 * 1024) })),
    }), (error: unknown) => error instanceof ConnectorRegistrationError && error.status === 502);
});

test('refuses a canonical returned domain that differs from the configured domain', async () => {
    await assert.rejects(registerConnector({
        ...options,
        fetcher: async () => Response.json({
            id: 'example', domain: 'other.helloerik.ai', browserProxySecret: 'browser_proxy_secret_0123456789abcdef',
        }),
    }), (error: unknown) => error instanceof ConnectorRegistrationError && error.status === 502);
});

test('reports registration HTTP failures with a typed error', async () => {
    await assert.rejects(registerConnector({
        ...options, secret: 'wrong',
        fetcher: async () => Response.json({ error: 'Invalid connector credential' }, { status: 401 }),
    }), (error: unknown) => error instanceof ConnectorRegistrationError && error.status === 401);
});
