export interface RegisterConnectorOptions {
    apiUrl: string;
    connectorId: string;
    secret: string;
    fetcher?: typeof fetch;
}
export declare class ConnectorRegistrationError extends Error {
    readonly status: number;
    constructor(status: number);
}
/** Sends the authenticated liveness signal used by existing Erik connectors. */
export declare function registerConnector(input: RegisterConnectorOptions): Promise<void>;
