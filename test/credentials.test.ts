import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CredentialClient, CredentialClientError, type CredentialUseOptions } from '../src/index.js';

interface Call { url: string; method: string; headers: Headers; body?: string }

function sequence(responses: Response[], calls: Call[]): typeof fetch {
    return async (input, init) => {
        calls.push({
            url: String(input),
            method: init?.method ?? 'GET',
            headers: new Headers(init?.headers),
            ...(init?.body !== undefined && { body: String(init.body) }),
        });
        const response = responses.shift();
        if (!response) throw new Error('Unexpected request');
        return response;
    };
}

const acquired = () => Response.json({ lease: { holder: 'holder', token: 7, expiresAt: '2026-01-01T00:00:00.000Z' } }, { status: 201 });
const released = () => Response.json({ released: true });

test('claims setup with the existing call secret and returns strict authoritative context', async () => {
    const calls: Call[] = [];
    const signal = new AbortController().signal;
    const expiresAt = '2026-01-01T00:00:00.000Z';
    const client = new CredentialClient('https://api.example/', 'example', {
        fetcher: sequence([Response.json({ setup: {
            orgId: 'org:a', connectionId: 'connection/1', setupAttempt: 'attempt-1', expiresAt,
        } })], calls),
        now: () => 0,
    });

    const claim = await client.claimSetup('org:a', 'connection/1', 'call-secret', 'attempt-1', {
        deadline: new Date(5_000), signal,
    });

    assert.deepEqual(claim, { orgId: 'org:a', connectionId: 'connection/1', setupAttempt: 'attempt-1', expiresAt });
    assert.deepEqual(calls.map(({ method, url }) => [method, url]), [[
        'POST', 'https://api.example/api/connector/credentials/org%3Aa/connection%2F1/claim',
    ]]);
    assert.equal(calls[0]!.headers.get('x-erik-connector'), 'example');
    assert.equal(calls[0]!.headers.get('x-erik-call-secret'), 'call-secret');
    assert.equal(calls[0]!.headers.get('authorization'), null);
    assert.equal(calls[0]!.headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(calls[0]!.body!), { setupAttempt: 'attempt-1' });
});

test('bounds setup claims by default and combines earlier deadlines with caller cancellation', async () => {
    const originalTimeout = AbortSignal.timeout;
    const durations: number[] = [];
    const timeoutControllers: AbortController[] = [];
    AbortSignal.timeout = milliseconds => {
        durations.push(milliseconds);
        const controller = new AbortController();
        timeoutControllers.push(controller);
        return controller.signal;
    };
    try {
        const signals: AbortSignal[] = [];
        const response = () => Response.json({ setup: {
            orgId: 'org', connectionId: 'connection', setupAttempt: 'attempt', expiresAt: '2026-01-01T00:00:00.000Z',
        } });
        const client = new CredentialClient('https://api.example', 'example', {
            now: () => 1_000,
            fetcher: async (_input, init) => {
                assert.ok(init?.signal instanceof AbortSignal);
                signals.push(init.signal);
                return response();
            },
        });

        await client.claimSetup('org', 'connection', 'secret', 'attempt');
        assert.equal(signals[0], timeoutControllers[0]!.signal);

        const caller = new AbortController();
        await client.claimSetup('org', 'connection', 'secret', 'attempt', {
            deadline: new Date(1_400), signal: caller.signal,
        });
        assert.notEqual(signals[1], caller.signal);
        assert.notEqual(signals[1], timeoutControllers[1]!.signal);
        caller.abort(new Error('setup cancelled'));
        assert.equal(signals[1]!.aborted, true);
        assert.equal((signals[1]!.reason as Error).message, 'setup cancelled');

        assert.deepEqual(durations, [10_000, 400]);
    } finally {
        AbortSignal.timeout = originalTimeout;
    }
});

test('refuses failed setup claims before caller side effects', async () => {
    let providerStarted = false;
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: async () => new Response(null, { status: 401 }),
    });

    await assert.rejects((async () => {
        await client.claimSetup('org', 'connection', 'expired', 'attempt');
        providerStarted = true;
    })(), (error: unknown) => error instanceof CredentialClientError && error.code === 'invalid-call' && error.status === 401);
    assert.equal(providerStarted, false);
});

test('refuses malformed setup claim responses', async () => {
    const valid = { orgId: 'org', connectionId: 'connection', setupAttempt: 'attempt', expiresAt: '2026-01-01T00:00:00.000Z' };
    const cases: unknown[] = [
        null,
        { ...valid, orgId: '' },
        { ...valid, connectionId: 1 },
        { ...valid, setupAttempt: 'other' },
        { ...valid, expiresAt: 'tomorrow' },
        { ...valid, extra: true },
    ];
    for (const value of cases) {
        const client = new CredentialClient('https://api.example', 'example', {
            fetcher: async () => Response.json({ setup: value }),
        });
        await assert.rejects(client.claimSetup('org', 'connection', 'secret', 'attempt'),
            (error: unknown) => error instanceof CredentialClientError && error.code === 'malformed-response');
    }
    const invalidJson = new CredentialClient('https://api.example', 'example', {
        fetcher: async () => new Response('not json'),
    });
    await assert.rejects(invalidJson.claimSetup('org', 'connection', 'secret', 'attempt'),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'malformed-response');

    const invalidEnvelope = new CredentialClient('https://api.example', 'example', {
        fetcher: async () => Response.json({ setup: valid, extra: true }),
    });
    await assert.rejects(invalidEnvelope.claimSetup('org', 'connection', 'secret', 'attempt'),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'malformed-response');
});

test('setup claim propagates cancellation and refuses an elapsed deadline before network activity', async () => {
    const controller = new AbortController();
    controller.abort(new Error('setup cancelled'));
    let calls = 0;
    const client = new CredentialClient('https://api.example', 'example', {
        now: () => 100,
        fetcher: async (_input, init) => {
            calls++;
            init?.signal?.throwIfAborted();
            throw new Error('Unexpected request');
        },
    });
    await assert.rejects(client.claimSetup('org', 'connection', 'secret', 'attempt', {
        deadline: new Date(200), signal: controller.signal,
    }), (error: unknown) => error instanceof CredentialClientError && error.code === 'unavailable'
        && error.cause instanceof Error && error.cause.message === 'setup cancelled');
    assert.equal(calls, 1);

    await assert.rejects(client.claimSetup('org', 'connection', 'secret', 'attempt', { deadline: new Date(100) }),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'invalid-call');
    await assert.rejects(client.claimSetup('org', 'connection', 'secret', 'attempt', { deadline: new Date('invalid') }),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'invalid-call');
    assert.equal(calls, 1);
});

test('acquires, reads, replaces and releases using one lease and encoded resource address', async () => {
    const calls: Call[] = [];
    const client = new CredentialClient('https://api.example/', 'example', { fetcher: sequence([
        acquired(),
        Response.json({ credential: { refreshToken: 'old' } }),
        Response.json({ stored: true }),
        released(),
    ], calls) });
    const order: string[] = [];
    const result = await client.withCredential('org:a', 'connection/1', 'call-secret', async (credential, replace) => {
        order.push(`read:${credential.refreshToken}`);
        await replace({ refreshToken: 'new' });
        order.push('replaced');
        return 'result';
    });
    assert.equal(result, 'result');
    assert.deepEqual(order, ['read:old', 'replaced']);
    assert.deepEqual(calls.map(({ method, url }) => [method, url]), [
        ['POST', 'https://api.example/api/connector/credentials/org%3Aa/connection%2F1/lease'],
        ['GET', 'https://api.example/api/connector/credentials/org%3Aa/connection%2F1'],
        ['PUT', 'https://api.example/api/connector/credentials/org%3Aa/connection%2F1'],
        ['DELETE', 'https://api.example/api/connector/credentials/org%3Aa/connection%2F1/lease'],
    ]);
    assert.equal(calls[0]!.headers.get('x-erik-call-secret'), 'call-secret');
    for (const call of calls.slice(1)) assert.equal(call.headers.get('x-erik-credential-lease'), 'holder:7');
    assert.deepEqual(JSON.parse(calls[2]!.body!), { refreshToken: 'new' });
});

test('retries 409 every 200ms through the ten-second deadline without changing the capability', async () => {
    let time = 0;
    const sleeps: number[] = [];
    const secrets: string[] = [];
    let attempts = 0;
    const fetcher: typeof fetch = async (_input, init) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
            attempts++;
            secrets.push(new Headers(init?.headers).get('x-erik-call-secret')!);
            return attempts === 3 ? acquired() : Response.json({ error: 'busy' }, { status: 409 });
        }
        if (method === 'GET') return Response.json({ credential: { token: 'value' } });
        return released();
    };
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher,
        now: () => time,
        sleep: async milliseconds => { sleeps.push(milliseconds); time += milliseconds; },
    });
    assert.equal(await client.withCredential('org', 'connection', 'same-secret', async credential => credential.token), 'value');
    assert.deepEqual(sleeps, [200, 200]);
    assert.deepEqual(secrets, ['same-secret', 'same-secret', 'same-secret']);
});

test('stops retrying a busy lease at the deadline with a typed unavailable error', async () => {
    let time = 0;
    let attempts = 0;
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: async () => { attempts++; return Response.json({ error: 'busy' }, { status: 409 }); },
        now: () => time,
        sleep: async milliseconds => { time += milliseconds; },
    });
    await assert.rejects(client.store('org', 'connection', 'secret', { token: 'value' }),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'unavailable' && error.status === 409);
    assert.equal(attempts, 51);
    assert.equal(time, 10_000);
});

test('stores only after preparation while holding the acquired lease', async () => {
    const order: string[] = [];
    const calls: Call[] = [];
    const fetcher: typeof fetch = async (input, init) => {
        const method = init?.method ?? 'GET';
        calls.push({ url: String(input), method, headers: new Headers(init?.headers),
            ...(init?.body !== undefined && { body: String(init.body) }) });
        order.push(method);
        if (method === 'POST') return acquired();
        if (method === 'PUT') return Response.json({ stored: true });
        return released();
    };
    const client = new CredentialClient('https://api.example', 'example', { fetcher });

    await client.storePrepared('org', 'connection', 'secret', { token: 'new' }, async () => {
        order.push('prepare');
    });

    assert.deepEqual(order, ['POST', 'prepare', 'PUT', 'DELETE']);
    assert.deepEqual(calls.map(call => call.method), ['POST', 'PUT', 'DELETE']);
    assert.equal(calls[1]!.headers.get('x-erik-credential-lease'), 'holder:7');
    assert.deepEqual(JSON.parse(calls[1]!.body!), { token: 'new' });
});

test('store forwards deadline and signal options to prepared storage', async () => {
    const client = new CredentialClient('https://api.example', 'example');
    const controller = new AbortController();
    const options = { deadline: new Date(Date.now() + 5_000), signal: controller.signal };
    let forwarded: CredentialUseOptions | undefined;
    client.storePrepared = async (...args) => { forwarded = args[5]; };

    await client.store('org', 'connection', 'secret', { token: 'new' }, options);

    assert.equal(forwarded, options);
});

test('store forwards an already-aborted signal and does not mutate credentials', async () => {
    const controller = new AbortController();
    controller.abort(new Error('setup expired'));
    const methods: string[] = [];
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: async (_input, init) => {
            methods.push(init?.method ?? 'GET');
            init?.signal?.throwIfAborted();
            throw new Error('Unexpected request');
        },
    });

    await assert.rejects(client.store('org', 'connection', 'secret', { token: 'new' }, {
        deadline: new Date(Date.now() + 5_000), signal: controller.signal,
    }), (error: unknown) => error instanceof CredentialClientError && error.code === 'unavailable'
        && error.cause instanceof Error && error.cause.message === 'setup expired');
    assert.deepEqual(methods, ['POST']);
});

test('store observes cancellation after acquisition and does not mutate credentials', async () => {
    const controller = new AbortController();
    const methods: string[] = [];
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: async (_input, init) => {
            const method = init?.method ?? 'GET';
            methods.push(method);
            if (method === 'POST') {
                queueMicrotask(() => controller.abort(new Error('setup deadline reached')));
                return acquired();
            }
            return released();
        },
    });

    await assert.rejects(client.store('org', 'connection', 'secret', { token: 'new' }, {
        deadline: new Date(Date.now() + 5_000), signal: controller.signal,
    }), /setup deadline reached/);
    assert.deepEqual(methods, ['POST', 'DELETE']);
});

test('does not read or write a credential when preparation fails and releases the lease', async () => {
    const calls: Call[] = [];
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: sequence([acquired(), released()], calls),
    });

    await assert.rejects(client.storePrepared('org', 'connection', 'secret', { token: 'new' }, async () => {
        throw new Error('provider setup failed');
    }), /provider setup failed/);
    assert.deepEqual(calls.map(call => call.method), ['POST', 'DELETE']);
});

test('cancellation after acquisition prevents the write and still releases the lease', async () => {
    const controller = new AbortController();
    const calls: Call[] = [];
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: sequence([acquired(), released()], calls),
    });

    await assert.rejects(client.storePrepared('org', 'connection', 'secret', { token: 'new' }, async () => {
        controller.abort(new Error('setup cancelled'));
    }, { deadline: new Date(Date.now() + 5_000), signal: controller.signal }), /setup cancelled/);
    assert.deepEqual(calls.map(call => call.method), ['POST', 'DELETE']);
});

test('prepared-store release settles by the deadline without replacing the primary error', async () => {
    const controller = new AbortController();
    let releaseSignal: AbortSignal | null | undefined;
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: async (_input, init) => {
            const method = init?.method ?? 'GET';
            if (method === 'POST') return acquired();
            releaseSignal = init?.signal;
            return new Promise<Response>(() => undefined);
        },
    });
    const started = Date.now();

    await assert.rejects(client.storePrepared('org', 'connection', 'secret', {}, async () => {
        controller.abort(new Error('operation cancelled'));
        throw new Error('provider setup failed');
    }, { deadline: new Date(started + 50), signal: controller.signal }), /provider setup failed/);

    assert(releaseSignal);
    assert.equal(releaseSignal.aborted, true);
    assert(Date.now() - started < 500);
});

test('classifies prepared-store acquisition and write failures like store', async () => {
    const invalid = new CredentialClient('https://api.example', 'example', {
        fetcher: async () => Response.json({ error: 'invalid' }, { status: 401 }),
    });
    await assert.rejects(invalid.storePrepared('org', 'connection', 'secret', {}, async () => undefined),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'invalid-call' && error.status === 401);

    const calls: Call[] = [];
    const failed = new CredentialClient('https://api.example', 'example', {
        fetcher: sequence([acquired(), Response.json({ error: 'failed' }, { status: 503 }), released()], calls),
    });
    await assert.rejects(failed.storePrepared('org', 'connection', 'secret', {}, async () => undefined),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'store-failed' && error.status === 503);
    assert.deepEqual(calls.map(call => call.method), ['POST', 'PUT', 'DELETE']);
});

test('credential acquisition cannot retry past the invocation deadline', async () => {
    let time = 0;
    let attempts = 0;
    const signal = new AbortController().signal;
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: async (_input, init) => {
            attempts++;
            assert.equal(init?.signal, signal);
            return Response.json({ error: 'busy' }, { status: 409 });
        },
        now: () => time,
        sleep: async milliseconds => { time += milliseconds; },
    });
    await assert.rejects(client.withCredential('org', 'connection', 'secret', async () => undefined,
        { deadline: new Date(400), signal }),
    (error: unknown) => error instanceof CredentialClientError && error.code === 'unavailable');
    assert.equal(attempts, 3);
    assert.equal(time, 400);
});

test('maps 401 acquisition to invalid-call without attempting credential access or release', async () => {
    let calls = 0;
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: async () => { calls++; return Response.json({ error: 'invalid' }, { status: 401 }); },
    });
    await assert.rejects(client.store('org', 'connection', 'expired', { token: 'value' }),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'invalid-call' && error.status === 401);
    assert.equal(calls, 1);
});

test('reports malformed JSON, malformed leases and malformed credentials', async () => {
    const invalidJson = new CredentialClient('https://api.example', 'example', {
        fetcher: async () => new Response('not json', { status: 201 }),
    });
    await assert.rejects(invalidJson.store('org', 'connection', 'secret', {}),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'malformed-response');

    const invalidLease = new CredentialClient('https://api.example', 'example', {
        fetcher: async () => Response.json({ lease: { holder: '', token: 0 } }, { status: 201 }),
    });
    await assert.rejects(invalidLease.store('org', 'connection', 'secret', {}),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'malformed-response');

    const calls: Call[] = [];
    const invalidCredential = new CredentialClient('https://api.example', 'example', { fetcher: sequence([
        acquired(), Response.json({ credential: 'secret' }), released(),
    ], calls) });
    await assert.rejects(invalidCredential.withCredential('org', 'connection', 'secret', async () => undefined),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'malformed-response');
    assert.deepEqual(calls.map(call => call.method), ['POST', 'GET', 'DELETE']);
});

test('uses provider-facing not-connected and replacement messages while retaining typed errors', async () => {
    const notConnected = new CredentialClient('https://api.example', 'example', {
        fetcher: sequence([acquired(), Response.json({ error: 'missing' }, { status: 404 }), released()], []),
        messages: { notConnected: 'Example is not connected' },
    });
    await assert.rejects(notConnected.withCredential('org', 'connection', 'secret', async () => undefined),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'not-connected'
            && error.message === 'Example is not connected');

    const replacement = new CredentialClient('https://api.example', 'example', {
        fetcher: sequence([acquired(), Response.json({ credential: { refreshToken: 'old' } }),
            Response.json({ error: 'stale lease' }, { status: 409 }), released()], []),
        messages: { replacementFailed: 'Updated Example login could not be saved' },
    });
    await assert.rejects(replacement.withCredential('org', 'connection', 'secret', async (_credential, replace) => {
        await replace({ refreshToken: 'new' });
    }), (error: unknown) => error instanceof CredentialClientError && error.code === 'replacement-failed'
        && error.message === 'Updated Example login could not be saved' && error.status === 409);
});

test('always attempts best-effort release and never masks callback or store failures', async () => {
    const callbackCalls: string[] = [];
    const callbackClient = new CredentialClient('https://api.example', 'example', {
        fetcher: async (_input, init) => {
            const method = init?.method ?? 'GET';
            callbackCalls.push(method);
            if (method === 'POST') return acquired();
            if (method === 'GET') return Response.json({ credential: { token: 'value' } });
            throw new Error('release failed');
        },
    });
    await assert.rejects(callbackClient.withCredential('org', 'connection', 'secret', async () => {
        throw new Error('provider failed');
    }), /provider failed/);
    assert.deepEqual(callbackCalls, ['POST', 'GET', 'DELETE']);

    const storeCalls: string[] = [];
    const storeClient = new CredentialClient('https://api.example', 'example', {
        fetcher: async (_input, init) => {
            const method = init?.method ?? 'GET';
            storeCalls.push(method);
            if (method === 'POST') return acquired();
            if (method === 'PUT') return Response.json({ error: 'failed' }, { status: 500 });
            throw new Error('release failed');
        },
    });
    await assert.rejects(storeClient.store('org', 'connection', 'secret', { token: 'value' }),
        (error: unknown) => error instanceof CredentialClientError && error.code === 'store-failed');
    assert.deepEqual(storeCalls, ['POST', 'PUT', 'DELETE']);
});

test('does not wait past the invocation signal for best-effort release', async () => {
    const controller = new AbortController();
    let releaseSignal: AbortSignal | null | undefined;
    const client = new CredentialClient('https://api.example', 'example', {
        fetcher: async (_input, init) => {
            const method = init?.method ?? 'GET';
            if (method === 'POST') return acquired();
            if (method === 'GET') return Response.json({ credential: { token: 'value' } });
            releaseSignal = init?.signal;
            setImmediate(() => controller.abort());
            return new Promise<Response>(() => undefined);
        },
    });
    assert.equal(await client.withCredential('org', 'connection', 'secret', async () => 'result', {
        deadline: new Date(Date.now() + 5_000), signal: controller.signal,
    }), 'result');
    assert(releaseSignal);
    assert.equal(releaseSignal.aborted, true);
    assert.equal(controller.signal.aborted, true);
});
