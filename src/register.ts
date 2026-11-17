export interface RegisterConnectorOptions {
    apiUrl: string;
    connectorId: string;
    expectedDomain: string;
    secret: string;
    fetcher?: typeof fetch;
}

export interface ConnectorRegistrationResult {
    id: string;
    domain: string;
    browserProxySecret: string;
}

export class ConnectorRegistrationError extends Error {
    constructor(readonly status: number) {
        super(`Connector registration failed with HTTP ${status}`);
        this.name = 'ConnectorRegistrationError';
    }
}

async function limitedText(response: Response, limit: number): Promise<string> {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) throw new ConnectorRegistrationError(502);
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            throw new ConnectorRegistrationError(502);
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

function exactApiOrigin(value: string): boolean {
    if (!value || value.length > 300) return false;
    try {
        const url = new URL(value);
        if (url.origin !== value || url.username || url.password || url.hostname.includes('*')) return false;
        if (url.protocol === 'https:') return true;
        return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch {
        return false;
    }
}

function canonicalDomain(value: unknown): value is string {
    if (typeof value !== 'string' || !value || value.length > 300) return false;
    try {
        const url = new URL(`https://${value}`);
        return url.host === value && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password
            && !url.hostname.includes('*');
    } catch {
        return false;
    }
}

function registrationResult(value: unknown, expectedId: string, expectedDomain: string): ConnectorRegistrationResult {
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new ConnectorRegistrationError(502);
    const result = value as Record<string, unknown>;
    const allowed = new Set(['id', 'domain', 'lastSeenAt', 'browserProxySecret']);
    if (Object.keys(result).some(key => !allowed.has(key)) || result.id !== expectedId
        || !canonicalDomain(result.domain) || result.domain !== expectedDomain
        || typeof result.browserProxySecret !== 'string' || result.browserProxySecret.length < 32
        || result.browserProxySecret.length > 512 || !/^[A-Za-z0-9_-]+$/.test(result.browserProxySecret)) {
        throw new ConnectorRegistrationError(502);
    }
    return { id: result.id, domain: result.domain, browserProxySecret: result.browserProxySecret };
}

/** Sends the authenticated liveness signal and returns the connector's browser-proxy credential. */
export async function registerConnector(input: RegisterConnectorOptions): Promise<ConnectorRegistrationResult> {
    if (!exactApiOrigin(input.apiUrl) || !canonicalDomain(input.expectedDomain)) {
        throw new ConnectorRegistrationError(400);
    }
    const response = await (input.fetcher ?? fetch)(`${input.apiUrl}/api/connector/register`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: {
            Authorization: `Bearer ${input.secret}`,
            'X-Erik-Connector': input.connectorId,
            Accept: 'application/json',
        },
    });
    if (!response.ok) throw new ConnectorRegistrationError(response.status);
    let text: string;
    try { text = await limitedText(response, 16 * 1024); }
    catch (error) {
        if (error instanceof ConnectorRegistrationError) throw error;
        throw new ConnectorRegistrationError(502);
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new ConnectorRegistrationError(502); }
    return registrationResult(value, input.connectorId, input.expectedDomain);
}
