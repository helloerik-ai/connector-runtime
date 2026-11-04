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
    async store(orgId, connectionId, callSecret, credential) {
        const lease = await this.acquire(orgId, connectionId, callSecret);
        const resource = this.resource(orgId, connectionId);
        const headers = { ...this.leaseHeaders(lease), 'Content-Type': 'application/json' };
        try {
            const response = await this.request(resource, {
                method: 'PUT', headers, body: JSON.stringify(credential),
            }, 'store-failed', 'Credential could not be stored');
            if (!response.ok) {
                throw new CredentialClientError('store-failed', 'Credential could not be stored', response.status);
            }
        }
        finally {
            await this.release(resource, headers);
        }
    }
}
