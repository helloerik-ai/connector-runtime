export interface ConnectorCallHeaders {
    connectorId: string;
    orgId: string;
    connectionId: string;
    callSecret: string;
}
export type ConnectorCallHeaderErrorCode = 'missing' | 'empty' | 'multiple' | 'wrong-connector';
export declare class ConnectorCallHeaderError extends Error {
    readonly code: ConnectorCallHeaderErrorCode;
    readonly header: string;
    readonly status = 401;
    constructor(code: ConnectorCallHeaderErrorCode, header: string);
}
export type ConnectorCallHeaderSource = Headers | Record<string, string | string[] | undefined>;
/** Parses and authenticates the four headers on an Erik-to-connector invocation. */
export declare function parseConnectorCallHeaders(source: ConnectorCallHeaderSource, expectedConnectorId: string): ConnectorCallHeaders;
