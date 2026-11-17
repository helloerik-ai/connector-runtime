import type { ConnectorCallHeaderSource } from './call-headers.js';
/** @deprecated Legacy browser contract v1 transport headers. Browser contract v2 uses ordinary connector requests. */
export declare const CONNECTOR_BROWSER_HEADERS: {
    readonly connectorId: "X-Erik-Browser-Connector";
    readonly requestId: "X-Erik-Browser-Request-Id";
    readonly deadline: "X-Erik-Browser-Deadline";
    readonly bodySha256: "X-Erik-Browser-Body-SHA256";
    readonly signature: "X-Erik-Browser-Signature";
};
/** @deprecated Legacy browser contract v1 only. */
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
/** @deprecated Legacy browser contract v1 only. */
export interface SignedConnectorBrowserRequest {
    headers: Record<string, string>;
    requestId: string;
    deadline: Date;
}
/** @deprecated Legacy browser contract v1 only. */
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
/** @deprecated Legacy browser contract v1 only. */
export interface ConnectorBrowserRequest {
    connectorId: string;
    requestId: string;
    deadline: Date;
    bodySha256: string;
    signal: AbortSignal;
}
/** @deprecated Legacy browser contract v1 only. */
export type ConnectorBrowserRequestErrorCode = 'missing' | 'empty' | 'multiple' | 'wrong-connector' | 'invalid' | 'expired' | 'body-mismatch' | 'bad-signature';
/** @deprecated Legacy browser contract v1 only. */
export declare class ConnectorBrowserRequestError extends Error {
    readonly code: ConnectorBrowserRequestErrorCode;
    readonly field: string;
    readonly status: number;
    constructor(code: ConnectorBrowserRequestErrorCode, field: string);
}
/** @deprecated Legacy browser contract v1 only. Browser contract v2 forwards ordinary connector requests unchanged. */
export declare function signConnectorBrowserRequest(input: SignConnectorBrowserRequestOptions): SignedConnectorBrowserRequest;
/** @deprecated Legacy browser contract v1 only. This signature is not provider-operation authority. */
export declare function verifyConnectorBrowserRequest(input: VerifyConnectorBrowserRequestOptions): ConnectorBrowserRequest;
