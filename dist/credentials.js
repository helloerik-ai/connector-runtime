import { randomBytes } from 'node:crypto';
export class CredentialClientError extends Error {
    code;
    status;
    constructor(code, message, status, options) {
        super(message, options);
        this.code = code;
        this.status = status;
        this.name = 'CredentialClientError';
    }
}
const object = (value) => value && !Array.isArray(value) && typeof value === 'object' ? value : undefined;
async function json(response) {
    let value;
    try {
        value = await response.json();
    }
    catch (cause) {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned invalid JSON', response.status, { cause });
    }
    const found = object(value);
    if (!found) {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned invalid JSON', response.status);
    }
    return found;
}
function parseLease(value, status) {
    const found = object(value);
    if (!found || typeof found.holder !== 'string' || !found.holder || !Number.isSafeInteger(found.token)
        || found.token < 1 || typeof found.expiresAt !== 'string' || !found.expiresAt) {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid lease', status);
    }
    return found;
}
function parseSetupClaim(value, status) {
    const found = object(value);
    const allowed = new Set(['orgId', 'connectionId', 'setupAttempt', 'expiresAt']);
    if (!found || Object.keys(found).some(key => !allowed.has(key)) || Object.keys(found).length !== allowed.size
        || typeof found.orgId !== 'string' || !found.orgId || typeof found.connectionId !== 'string' || !found.connectionId
        || typeof found.setupAttempt !== 'string' || !found.setupAttempt || typeof found.expiresAt !== 'string') {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid setup claim', status);
    }
    const expiresAt = new Date(found.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== found.expiresAt) {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid setup claim', status);
    }
    return found;
}
function parseSetupContinuation(value, status) {
    const found = object(value);
    if (!found || typeof found.continuationSecret !== 'string' || found.continuationSecret.length < 20
        || found.continuationSecret.length > 500 || !/^[A-Za-z0-9_-]+$/.test(found.continuationSecret)) {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid setup continuation', status);
    }
    const { continuationSecret, ...claim } = found;
    return { ...parseSetupClaim(claim, status), continuationSecret };
}
export class CredentialClient {
    connectorId;
    apiUrl;
    fetcher;
    now;
    sleep;
    notConnectedMessage;
    replacementFailedMessage;
    constructor(apiUrl, connectorId, options = {}) {
        this.connectorId = connectorId;
        this.apiUrl = apiUrl.replace(/\/+$/, '');
        this.fetcher = options.fetcher ?? fetch;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
        this.notConnectedMessage = options.messages?.notConnected ?? 'Connector is not connected';
        this.replacementFailedMessage = options.messages?.replacementFailed ?? 'Rotated credential could not be stored';
    }
    resource(orgId, connectionId) {
        return `${this.apiUrl}/api/connector/credentials/${encodeURIComponent(orgId)}/${encodeURIComponent(connectionId)}`;
    }
    async request(url, init, code, message) {
        try {
            return await this.fetcher(url, init);
        }
        catch (cause) {
            throw new CredentialClientError(code, message, undefined, { cause });
        }
    }
    async claimSetup(orgId, connectionId, callSecret, setupAttempt, options = {}) {
        const remaining = Math.min(10_000, (options.deadline?.getTime() ?? Number.POSITIVE_INFINITY) - this.now());
        if (!Number.isFinite(remaining) || remaining <= 0) {
            throw new CredentialClientError('invalid-call', 'Connector call is invalid or expired', 401);
        }
        const timeout = AbortSignal.timeout(remaining);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        const response = await this.request(this.resource(orgId, connectionId) + '/claim', {
            method: 'POST',
            headers: {
                'X-Erik-Connector': this.connectorId,
                'X-Erik-Call-Secret': callSecret,
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            signal,
            body: JSON.stringify({ setupAttempt }),
        }, 'unavailable', 'Setup claim is unavailable');
        if (response.status === 401) {
            throw new CredentialClientError('invalid-call', 'Connector call is invalid or expired', 401);
        }
        if (!response.ok) {
            throw new CredentialClientError('unavailable', 'Setup claim is unavailable', response.status);
        }
        const payload = await json(response);
        if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'setup')) {
            throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid setup claim', response.status);
        }
        const claim = parseSetupClaim(payload.setup, response.status);
        if (claim.orgId !== orgId || claim.connectionId !== connectionId || claim.setupAttempt !== setupAttempt) {
            throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid setup claim', response.status);
        }
        return claim;
    }
    async claimSetupContinuation(orgId, connectionId, claimedSetupSecret, setupAttempt, options = {}) {
        const deadline = Math.min(this.now() + 10_000, options.deadline?.getTime() ?? Number.POSITIVE_INFINITY);
        if (!Number.isFinite(deadline) || deadline <= this.now()) {
            throw new CredentialClientError('invalid-call', 'Connector call is invalid or expired', 401);
        }
        const continuationSecret = randomBytes(32).toString('base64url');
        while (true) {
            if (options.signal?.aborted) {
                throw new CredentialClientError('unavailable', 'Setup continuation is unavailable', undefined, { cause: options.signal.reason });
            }
            const remaining = deadline - this.now();
            if (remaining <= 0)
                throw new CredentialClientError('unavailable', 'Setup continuation is unavailable');
            const timeout = AbortSignal.timeout(remaining);
            const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
            let response;
            try {
                response = await this.request(this.resource(orgId, connectionId) + '/continuation', {
                    method: 'POST',
                    headers: {
                        'X-Erik-Connector': this.connectorId,
                        'X-Erik-Call-Secret': claimedSetupSecret,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    signal,
                    body: JSON.stringify({ setupAttempt, continuationSecret }),
                }, 'unavailable', 'Setup continuation is unavailable');
            }
            catch (error) {
                if (!(error instanceof CredentialClientError) || error.code !== 'unavailable'
                    || options.signal?.aborted || this.now() >= deadline)
                    throw error;
                await this.sleep(Math.min(200, Math.max(0, deadline - this.now())));
                continue;
            }
            if (response.status === 401) {
                throw new CredentialClientError('invalid-call', 'Connector call is invalid or expired', 401);
            }
            if (!response.ok) {
                if (response.status < 500 || this.now() >= deadline) {
                    throw new CredentialClientError('unavailable', 'Setup continuation is unavailable', response.status);
                }
                await this.sleep(Math.min(200, Math.max(0, deadline - this.now())));
                continue;
            }
            const payload = await json(response);
            if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'continuation')) {
                throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid setup continuation', response.status);
            }
            const continuation = parseSetupContinuation(payload.continuation, response.status);
            if (continuation.orgId !== orgId || continuation.connectionId !== connectionId
                || continuation.setupAttempt !== setupAttempt || continuation.continuationSecret !== continuationSecret) {
                throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid setup continuation', response.status);
            }
            return continuation;
        }
    }
    async acquire(orgId, connectionId, callSecret, options = {}) {
        const url = this.resource(orgId, connectionId) + '/lease';
        const deadline = Math.min(this.now() + 10_000, options.deadline?.getTime() ?? Number.POSITIVE_INFINITY);
        if (deadline <= this.now())
            throw new CredentialClientError('invalid-call', 'Connector call is invalid or expired', 401);
        while (true) {
            const response = await this.request(url, {
                method: 'POST',
                ...(options.signal && { signal: options.signal }),
                headers: {
                    'X-Erik-Connector': this.connectorId,
                    'X-Erik-Call-Secret': callSecret,
                    Accept: 'application/json',
                },
            }, 'unavailable', 'Credential is unavailable');
            const payload = await json(response);
            if (response.ok)
                return parseLease(payload.lease, response.status);
            if (response.status !== 409 || this.now() >= deadline) {
                if (response.status === 401) {
                    throw new CredentialClientError('invalid-call', 'Connector call is invalid or expired', 401);
                }
                throw new CredentialClientError('unavailable', 'Credential is unavailable', response.status);
            }
            await this.sleep(Math.min(200, Math.max(0, deadline - this.now())));
        }
    }
    leaseHeaders(value) {
        return {
            'X-Erik-Connector': this.connectorId,
            'X-Erik-Credential-Lease': `${value.holder}:${value.token}`,
            Accept: 'application/json',
        };
    }
    async release(resource, headers, options = {}) {
        const remaining = Math.min(10_000, (options.deadline?.getTime() ?? Number.POSITIVE_INFINITY) - this.now());
        if (remaining <= 0 || options.signal?.aborted)
            return;
        const timeout = AbortSignal.timeout(remaining);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        try {
            await Promise.race([
                this.fetcher(resource + '/lease', { method: 'DELETE', headers, signal }),
                new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
            ]);
        }
        catch {
            // Releasing is best-effort and must not replace the operation's result or primary error.
        }
    }
    async withCredential(orgId, connectionId, callSecret, use, options = {}) {
        const lease = await this.acquire(orgId, connectionId, callSecret, options);
        const resource = this.resource(orgId, connectionId);
        const headers = this.leaseHeaders(lease);
        try {
            const response = await this.request(resource, {
                headers, ...(options.signal && { signal: options.signal }),
            }, 'unavailable', 'Credential is unavailable');
            const payload = await json(response);
            const stored = object(payload.credential);
            if (!response.ok || !stored) {
                if (response.status === 404) {
                    throw new CredentialClientError('not-connected', this.notConnectedMessage, 404);
                }
                if (response.ok) {
                    throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid credential', response.status);
                }
                throw new CredentialClientError('unavailable', 'Credential is unavailable', response.status);
            }
            const replace = async (credential) => {
                const updated = await this.request(resource, {
                    method: 'PUT',
                    headers: { ...headers, 'Content-Type': 'application/json' },
                    ...(options.signal && { signal: options.signal }),
                    body: JSON.stringify(credential),
                }, 'replacement-failed', this.replacementFailedMessage);
                if (!updated.ok) {
                    throw new CredentialClientError('replacement-failed', this.replacementFailedMessage, updated.status);
                }
            };
            return await use(stored, replace);
        }
        finally {
            await this.release(resource, headers, options);
        }
    }
    async storePrepared(orgId, connectionId, callSecret, credential, prepare, options = {}) {
        const lease = await this.acquire(orgId, connectionId, callSecret, options);
        const resource = this.resource(orgId, connectionId);
        const headers = { ...this.leaseHeaders(lease), 'Content-Type': 'application/json' };
        try {
            options.signal?.throwIfAborted();
            await prepare();
            options.signal?.throwIfAborted();
            const response = await this.request(resource, {
                method: 'PUT', headers, body: JSON.stringify(credential),
                ...(options.signal && { signal: options.signal }),
            }, 'store-failed', 'Credential could not be stored');
            if (!response.ok) {
                throw new CredentialClientError('store-failed', 'Credential could not be stored', response.status);
            }
        }
        finally {
            await this.release(resource, headers, { ...(options.deadline && { deadline: options.deadline }) });
        }
    }
    async store(orgId, connectionId, callSecret, credential, options = {}) {
        await this.storePrepared(orgId, connectionId, callSecret, credential, async () => undefined, options);
    }
}
