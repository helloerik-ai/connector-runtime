export type Credential = Record<string, unknown>;

interface CredentialLease {
    holder: string;
    token: number;
    expiresAt: string;
}

export type CredentialClientErrorCode =
    | 'invalid-call'
    | 'unavailable'
    | 'malformed-response'
    | 'not-connected'
    | 'replacement-failed'
    | 'store-failed';

export class CredentialClientError extends Error {
    constructor(
        readonly code: CredentialClientErrorCode,
        message: string,
        readonly status?: number,
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'CredentialClientError';
    }
}

export interface CredentialClientOptions {
    fetcher?: typeof fetch;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    messages?: {
        notConnected?: string;
        replacementFailed?: string;
    };
}

export interface CredentialUseOptions {
    deadline?: Date;
    signal?: AbortSignal;
}

const object = (value: unknown): Record<string, unknown> | undefined =>
    value && !Array.isArray(value) && typeof value === 'object' ? value as Record<string, unknown> : undefined;

async function json(response: Response): Promise<Record<string, unknown>> {
    let value: unknown;
    try {
        value = await response.json();
    } catch (cause) {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned invalid JSON', response.status, { cause });
    }
    const found = object(value);
    if (!found) {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned invalid JSON', response.status);
    }
    return found;
}

function parseLease(value: unknown, status: number): CredentialLease {
    const found = object(value);
    if (!found || typeof found.holder !== 'string' || !found.holder || !Number.isSafeInteger(found.token)
        || (found.token as number) < 1 || typeof found.expiresAt !== 'string' || !found.expiresAt) {
        throw new CredentialClientError('malformed-response', 'Erik credential service returned an invalid lease', status);
    }
    return found as unknown as CredentialLease;
}

export class CredentialClient {
    private readonly apiUrl: string;
    private readonly fetcher: typeof fetch;
    private readonly now: () => number;
    private readonly sleep: (milliseconds: number) => Promise<void>;
    private readonly notConnectedMessage: string;
    private readonly replacementFailedMessage: string;

    constructor(apiUrl: string, private readonly connectorId: string, options: CredentialClientOptions = {}) {
        this.apiUrl = apiUrl.replace(/\/+$/, '');
        this.fetcher = options.fetcher ?? fetch;
        this.now = options.now ?? Date.now;
        this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
        this.notConnectedMessage = options.messages?.notConnected ?? 'Connector is not connected';
        this.replacementFailedMessage = options.messages?.replacementFailed ?? 'Rotated credential could not be stored';
    }

    private resource(orgId: string, connectionId: string): string {
        return `${this.apiUrl}/api/connector/credentials/${encodeURIComponent(orgId)}/${encodeURIComponent(connectionId)}`;
    }

    private async request(
        url: string,
        init: RequestInit,
        code: CredentialClientErrorCode,
        message: string,
    ): Promise<Response> {
        try {
            return await this.fetcher(url, init);
        } catch (cause) {
            throw new CredentialClientError(code, message, undefined, { cause });
        }
    }

    private async acquire(orgId: string, connectionId: string, callSecret: string, options: CredentialUseOptions = {}): Promise<CredentialLease> {
        const url = this.resource(orgId, connectionId) + '/lease';
        const deadline = Math.min(this.now() + 10_000, options.deadline?.getTime() ?? Number.POSITIVE_INFINITY);
        if (deadline <= this.now()) throw new CredentialClientError('invalid-call', 'Connector call is invalid or expired', 401);
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
            if (response.ok) return parseLease(payload.lease, response.status);
            if (response.status !== 409 || this.now() >= deadline) {
                if (response.status === 401) {
                    throw new CredentialClientError('invalid-call', 'Connector call is invalid or expired', 401);
                }
                throw new CredentialClientError('unavailable', 'Credential is unavailable', response.status);
            }
            await this.sleep(Math.min(200, Math.max(0, deadline - this.now())));
        }
    }

    private leaseHeaders(value: CredentialLease): Record<string, string> {
        return {
            'X-Erik-Connector': this.connectorId,
            'X-Erik-Credential-Lease': `${value.holder}:${value.token}`,
            Accept: 'application/json',
        };
    }

    private async release(resource: string, headers: Record<string, string>, options: CredentialUseOptions = {}): Promise<void> {
        const remaining = Math.min(10_000, (options.deadline?.getTime() ?? Number.POSITIVE_INFINITY) - this.now());
        if (remaining <= 0 || options.signal?.aborted) return;
        const timeout = AbortSignal.timeout(remaining);
        const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
        try {
            await Promise.race([
                this.fetcher(resource + '/lease', { method: 'DELETE', headers, signal }),
                new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
            ]);
        } catch {
            // Releasing is best-effort and must not replace the operation's result or primary error.
        }
    }

    async withCredential<T>(
        orgId: string,
        connectionId: string,
        callSecret: string,
        use: (credential: Credential, replace: (credential: Credential) => Promise<void>) => Promise<T>,
        options: CredentialUseOptions = {},
    ): Promise<T> {
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
            const replace = async (credential: Credential): Promise<void> => {
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
        } finally {
            await this.release(resource, headers, options);
        }
    }

    async store(orgId: string, connectionId: string, callSecret: string, credential: Credential): Promise<void> {
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
        } finally {
            await this.release(resource, headers);
        }
    }
}
