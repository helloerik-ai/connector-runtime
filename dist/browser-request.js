import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
export const CONNECTOR_BROWSER_HEADERS = {
    connectorId: 'X-Erik-Browser-Connector',
    requestId: 'X-Erik-Browser-Request-Id',
    deadline: 'X-Erik-Browser-Deadline',
    bodySha256: 'X-Erik-Browser-Body-SHA256',
    signature: 'X-Erik-Browser-Signature',
};
export class ConnectorBrowserRequestError extends Error {
    code;
    field;
    status;
    constructor(code, field) {
        super(code === 'expired' ? 'Connector browser request expired' : 'Connector browser request authentication failed');
        this.code = code;
        this.field = field;
        this.name = 'ConnectorBrowserRequestError';
        this.status = code === 'expired' ? 408 : ['invalid', 'body-mismatch'].includes(code) ? 400 : 401;
    }
}
const CONNECTOR_ID = /^[a-z][a-z0-9-]{1,63}$/;
const INTERNAL_PATH = /^\/erik\/browser\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;
const REQUEST_ID = /^[\x21-\x7e]{1,200}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
function validateRequestFields(secret, connectorId, method, path, query, body, requestId) {
    if (secret.length < 32 || secret.length > 512 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
        throw new ConnectorBrowserRequestError('invalid', 'secret');
    }
    if (!CONNECTOR_ID.test(connectorId))
        throw new ConnectorBrowserRequestError('invalid', 'connectorId');
    if (!/^[A-Z]+$/.test(method) || method.length > 16)
        throw new ConnectorBrowserRequestError('invalid', 'method');
    if (path.length > 300 || !INTERNAL_PATH.test(path))
        throw new ConnectorBrowserRequestError('invalid', 'path');
    if (query.length > 8_192 || (query !== '' && !/^[\x21-\x7e]+$/.test(query)) || query.startsWith('?')) {
        throw new ConnectorBrowserRequestError('invalid', 'query');
    }
    if ((typeof body === 'string' ? Buffer.byteLength(body) : body.byteLength) > 64 * 1024) {
        throw new ConnectorBrowserRequestError('invalid', 'body');
    }
    if (!REQUEST_ID.test(requestId) || requestId.includes(','))
        throw new ConnectorBrowserRequestError('invalid', 'requestId');
}
function canonical(connectorId, method, path, query, bodySha256, requestId, deadline) {
    return [connectorId, method, path, query, bodySha256, requestId, deadline].join('\n');
}
function digest(body) {
    return createHash('sha256').update(body).digest('hex');
}
function deadlineRemaining(value, now) {
    const deadline = new Date(value);
    if (!Number.isFinite(deadline.getTime()) || deadline.toISOString() !== value) {
        throw new ConnectorBrowserRequestError('invalid', CONNECTOR_BROWSER_HEADERS.deadline);
    }
    const remaining = deadline.getTime() - now;
    if (remaining <= 0)
        throw new ConnectorBrowserRequestError('expired', CONNECTOR_BROWSER_HEADERS.deadline);
    if (remaining > 60_000)
        throw new ConnectorBrowserRequestError('invalid', CONNECTOR_BROWSER_HEADERS.deadline);
    return { deadline, remaining };
}
function singletonHeader(source, name) {
    let values;
    if (source instanceof Headers) {
        const value = source.get(name);
        values = value === null ? [] : [value];
    }
    else {
        values = Object.entries(source)
            .filter(([key]) => key.toLowerCase() === name.toLowerCase())
            .flatMap(([, value]) => value === undefined ? [] : Array.isArray(value) ? value : [value]);
    }
    if (values.length === 0)
        throw new ConnectorBrowserRequestError('missing', name);
    if (values.length !== 1 || values[0].includes(','))
        throw new ConnectorBrowserRequestError('multiple', name);
    if (!values[0].trim())
        throw new ConnectorBrowserRequestError('empty', name);
    return values[0];
}
/** Signs the exact request Erik will send to a connector's internal browser namespace. */
export function signConnectorBrowserRequest(input) {
    const now = (input.now ?? Date.now)();
    const requestId = input.requestId ?? randomUUID();
    const deadline = input.deadline ?? new Date(now + 30_000);
    validateRequestFields(input.secret, input.connectorId, input.method, input.path, input.query, input.body, requestId);
    if (!Number.isFinite(deadline.getTime())) {
        throw new ConnectorBrowserRequestError('invalid', CONNECTOR_BROWSER_HEADERS.deadline);
    }
    const deadlineValue = deadline.toISOString();
    deadlineRemaining(deadlineValue, now);
    const bodySha256 = digest(input.body);
    const signature = createHmac('sha256', input.secret)
        .update(canonical(input.connectorId, input.method, input.path, input.query, bodySha256, requestId, deadlineValue))
        .digest('hex');
    return {
        headers: {
            [CONNECTOR_BROWSER_HEADERS.connectorId]: input.connectorId,
            [CONNECTOR_BROWSER_HEADERS.requestId]: requestId,
            [CONNECTOR_BROWSER_HEADERS.deadline]: deadlineValue,
            [CONNECTOR_BROWSER_HEADERS.bodySha256]: bodySha256,
            [CONNECTOR_BROWSER_HEADERS.signature]: signature,
        },
        requestId,
        deadline,
    };
}
/** Verifies one signed browser request and creates the abort signal provider work must observe. */
export function verifyConnectorBrowserRequest(input) {
    const connectorId = singletonHeader(input.headers, CONNECTOR_BROWSER_HEADERS.connectorId);
    if (connectorId !== input.connectorId) {
        throw new ConnectorBrowserRequestError('wrong-connector', CONNECTOR_BROWSER_HEADERS.connectorId);
    }
    const requestId = singletonHeader(input.headers, CONNECTOR_BROWSER_HEADERS.requestId);
    validateRequestFields(input.secret, connectorId, input.method, input.path, input.query, input.body, requestId);
    const deadlineValue = singletonHeader(input.headers, CONNECTOR_BROWSER_HEADERS.deadline);
    const { deadline, remaining } = deadlineRemaining(deadlineValue, (input.now ?? Date.now)());
    const bodySha256 = singletonHeader(input.headers, CONNECTOR_BROWSER_HEADERS.bodySha256);
    if (!DIGEST.test(bodySha256) || bodySha256 !== digest(input.body)) {
        throw new ConnectorBrowserRequestError('body-mismatch', CONNECTOR_BROWSER_HEADERS.bodySha256);
    }
    const suppliedSignature = singletonHeader(input.headers, CONNECTOR_BROWSER_HEADERS.signature);
    if (!SIGNATURE.test(suppliedSignature)) {
        throw new ConnectorBrowserRequestError('bad-signature', CONNECTOR_BROWSER_HEADERS.signature);
    }
    const expectedSignature = createHmac('sha256', input.secret)
        .update(canonical(connectorId, input.method, input.path, input.query, bodySha256, requestId, deadlineValue))
        .digest();
    const supplied = Buffer.from(suppliedSignature, 'hex');
    if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) {
        throw new ConnectorBrowserRequestError('bad-signature', CONNECTOR_BROWSER_HEADERS.signature);
    }
    return { connectorId, requestId, deadline, bodySha256, signal: AbortSignal.timeout(remaining) };
}
