import type { ConnectorCallHeaderSource } from './call-headers.js';
export declare const CONNECTOR_BROWSER_HEADERS: {
    readonly connectorId: "X-Erik-Browser-Connector";
    readonly requestId: "X-Erik-Browser-Request-Id";
    readonly deadline: "X-Erik-Browser-Deadline";
    readonly bodySha256: "X-Erik-Browser-Body-SHA256";
    readonly signature: "X-Erik-Browser-Signature";
};
export interface SignConnectorBrowserRequestOptions {
    secret: string;
    connectorId: string;
    method: string;
    path: string;
    query: string;
    body: string | Uint8Array;
    requestId?: string;
    deadline?: Date;
    now?: () => number;
}
export interface SignedConnectorBrowserRequest {
    headers: Record<string, string>;
    requestId: string;
    deadline: Date;
}
export interface VerifyConnectorBrowserRequestOptions {
    headers: ConnectorCallHeaderSource;
    secret: string;
    connectorId: string;
    method: string;
    path: string;
    query: string;
    body: string | Uint8Array;
    now?: () => number;
}
export interface ConnectorBrowserRequest {
    connectorId: string;
    requestId: string;
    deadline: Date;
    bodySha256: string;
    signal: AbortSignal;
}
export type ConnectorBrowserRequestErrorCode = 'missing' | 'empty' | 'multiple' | 'wrong-connector' | 'invalid' | 'expired' | 'body-mismatch' | 'bad-signature';
export declare class ConnectorBrowserRequestError extends Error {
    readonly code: ConnectorBrowserRequestErrorCode;
    readonly field: string;
    readonly status: number;
    constructor(code: ConnectorBrowserRequestErrorCode, field: string);
}
/** Signs the exact request Erik will send to a connector's internal browser namespace. */
export declare function signConnectorBrowserRequest(input: SignConnectorBrowserRequestOptions): SignedConnectorBrowserRequest;
/** Verifies one signed browser request and creates the abort signal provider work must observe. */
export declare function verifyConnectorBrowserRequest(input: VerifyConnectorBrowserRequestOptions): ConnectorBrowserRequest;
