export interface ConnectorCallHeaders {
    connectorId: string;
    orgId: string;
    connectionId: string;
    callSecret: string;
}

export type ConnectorCallHeaderErrorCode = 'missing' | 'empty' | 'multiple' | 'wrong-connector';

export class ConnectorCallHeaderError extends Error {
    readonly status = 401;

    constructor(readonly code: ConnectorCallHeaderErrorCode, readonly header: string) {
        super(code === 'wrong-connector' ? 'Invalid connector call identity' : 'Connector call authentication required');
        this.name = 'ConnectorCallHeaderError';
    }
}

export type ConnectorCallHeaderSource = Headers | Record<string, string | string[] | undefined>;

function header(source: ConnectorCallHeaderSource, name: string): string {
    let values: string[];
    if (source instanceof Headers) {
        const value = source.get(name);
        values = value === null ? [] : [value];
    } else {
        values = Object.entries(source)
            .filter(([key]) => key.toLowerCase() === name.toLowerCase())
            .flatMap(([, value]) => value === undefined ? [] : Array.isArray(value) ? value : [value]);
    }
    if (values.length === 0) throw new ConnectorCallHeaderError('missing', name);
    // Fetch and Node may combine repeated non-cookie fields with commas before application code sees them.
    if (values.length !== 1 || values[0]!.includes(',')) throw new ConnectorCallHeaderError('multiple', name);
    if (!values[0]!.trim()) throw new ConnectorCallHeaderError('empty', name);
    return values[0]!;
}

/** Parses and authenticates the four headers on an Erik-to-connector invocation. */
export function parseConnectorCallHeaders(source: ConnectorCallHeaderSource, expectedConnectorId: string): ConnectorCallHeaders {
    const connectorId = header(source, 'X-Erik-Connector');
    if (connectorId !== expectedConnectorId) throw new ConnectorCallHeaderError('wrong-connector', 'X-Erik-Connector');
    return {
        connectorId,
        orgId: header(source, 'X-Erik-Org'),
        connectionId: header(source, 'X-Erik-Connection'),
        callSecret: header(source, 'X-Erik-Call-Secret'),
    };
}
