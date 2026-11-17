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
    browserProxySecret?: string;
}
export declare class ConnectorRegistrationError extends Error {
    readonly status: number;
    constructor(status: number);
}
/** Sends the authenticated liveness signal and returns any legacy v1 browser-proxy credential. */
export declare function registerConnector(input: RegisterConnectorOptions): Promise<ConnectorRegistrationResult>;
