export interface ConnectorCallHeaders {
    connectorId: string;
    orgId: string;
    connectionId: string;
    callSecret: string;
    invocationId: string;
    deadline: Date;
    signal: AbortSignal;
}
export type ConnectorCallHeaderErrorCode = 'missing' | 'empty' | 'multiple' | 'wrong-connector' | 'invalid' | 'expired';
export declare class ConnectorCallHeaderError extends Error {
    readonly code: ConnectorCallHeaderErrorCode;
    readonly header: string;
    readonly status: number;
    constructor(code: ConnectorCallHeaderErrorCode, header: string);
}
export type ConnectorCallHeaderSource = Headers | Record<string, string | string[] | undefined>;
/** Parses one authenticated invocation and creates the signal every provider operation must observe. */
export declare function parseConnectorCallHeaders(source: ConnectorCallHeaderSource, expectedConnectorId: string, options?: {
    now?: () => number;
}): ConnectorCallHeaders;
