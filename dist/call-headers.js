export class ConnectorCallHeaderError extends Error {
    code;
    header;
    status;
    constructor(code, header) {
        super(code === 'wrong-connector' ? 'Invalid connector call identity' : 'Connector call authentication required');
        this.code = code;
        this.header = header;
        this.name = 'ConnectorCallHeaderError';
        this.status = code === 'expired' ? 408 : code === 'invalid' ? 400 : 401;
    }
}
function header(source, name) {
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
        throw new ConnectorCallHeaderError('missing', name);
    // Fetch and Node may combine repeated non-cookie fields with commas before application code sees them.
    if (values.length !== 1 || values[0].includes(','))
        throw new ConnectorCallHeaderError('multiple', name);
    if (!values[0].trim())
        throw new ConnectorCallHeaderError('empty', name);
    return values[0];
}
/** Parses one authenticated invocation and creates the signal every provider operation must observe. */
export function parseConnectorCallHeaders(source, expectedConnectorId, options = {}) {
    const connectorId = header(source, 'X-Erik-Connector');
    if (connectorId !== expectedConnectorId)
        throw new ConnectorCallHeaderError('wrong-connector', 'X-Erik-Connector');
    const invocationId = header(source, 'X-Erik-Invocation');
    if (invocationId.length > 200 || !/^[\x21-\x7e]+$/.test(invocationId)) {
        throw new ConnectorCallHeaderError('invalid', 'X-Erik-Invocation');
    }
    const deadlineValue = header(source, 'X-Erik-Deadline');
    const deadline = new Date(deadlineValue);
    if (!Number.isFinite(deadline.getTime()) || deadline.toISOString() !== deadlineValue) {
        throw new ConnectorCallHeaderError('invalid', 'X-Erik-Deadline');
    }
    const remaining = deadline.getTime() - (options.now ?? Date.now)();
    if (remaining <= 0)
        throw new ConnectorCallHeaderError('expired', 'X-Erik-Deadline');
    if (remaining > 60_000)
        throw new ConnectorCallHeaderError('invalid', 'X-Erik-Deadline');
    return {
        connectorId,
        orgId: header(source, 'X-Erik-Org'),
        connectionId: header(source, 'X-Erik-Connection'),
        callSecret: header(source, 'X-Erik-Call-Secret'),
        invocationId,
        deadline,
        signal: AbortSignal.timeout(remaining),
    };
}
