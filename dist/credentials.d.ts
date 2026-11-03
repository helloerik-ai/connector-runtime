export type Credential = Record<string, unknown>;
export type CredentialClientErrorCode = 'invalid-call' | 'unavailable' | 'malformed-response' | 'not-connected' | 'replacement-failed' | 'store-failed';
export declare class CredentialClientError extends Error {
    readonly code: CredentialClientErrorCode;
    readonly status?: number | undefined;
    constructor(code: CredentialClientErrorCode, message: string, status?: number | undefined, options?: ErrorOptions);
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
export declare class CredentialClient {
    private readonly connectorId;
    private readonly apiUrl;
    private readonly fetcher;
    private readonly now;
    private readonly sleep;
    private readonly notConnectedMessage;
    private readonly replacementFailedMessage;
    constructor(apiUrl: string, connectorId: string, options?: CredentialClientOptions);
    private resource;
    private request;
    private acquire;
    private leaseHeaders;
    private release;
    withCredential<T>(orgId: string, connectionId: string, callSecret: string, use: (credential: Credential, replace: (credential: Credential) => Promise<void>) => Promise<T>): Promise<T>;
    store(orgId: string, connectionId: string, callSecret: string, credential: Credential): Promise<void>;
}
