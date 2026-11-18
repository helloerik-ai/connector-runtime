import type { SetupClaimContext } from './credentials.js';
export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
export interface ConnectorSetupRequest {
    orgId: string;
    connectionId: string;
    setupAttempt: string;
    callSecret: string;
    returnToken: string;
    installationSecret?: string;
}
export type SetupRequestErrorCode = 'content-type' | 'too-large' | 'malformed' | 'fields';
export declare class SetupRequestError extends Error {
    readonly code: SetupRequestErrorCode;
    constructor(code: SetupRequestErrorCode);
}
/** Strictly parses Erik browser-contract v2 setup form fields. */
export declare function parseConnectorSetupRequest(input: {
    contentType: string | readonly string[] | undefined;
    body: string | Uint8Array;
}): ConnectorSetupRequest;
export declare function randomSetupToken(bytes?: number): string;
/** Derives a non-revealing, attempt- or state-specific cookie name. */
export declare function setupCookieName(namespace: string, discriminator: string): string;
export interface SetupCookieOptions {
    path: string;
    maxAgeSeconds: number;
    origin?: string;
}
export declare function setupCookieHeader(name: string, value: string, options: SetupCookieOptions): string;
export declare function clearSetupCookieHeader(name: string, options: Omit<SetupCookieOptions, 'maxAgeSeconds'>): string;
/** Returns one unambiguous opaque cookie value and rejects malformed or duplicate cookie headers. */
export declare function parseSetupCookie(header: string | readonly string[] | undefined, name: string): string | undefined;
export type PendingSetupLifecycleErrorCode = 'invalid' | 'expired' | 'capacity' | 'attempt-used' | 'already-claimed' | 'browser-mismatch';
export declare class PendingSetupLifecycleError extends Error {
    readonly code: PendingSetupLifecycleErrorCode;
    constructor(code: PendingSetupLifecycleErrorCode);
}
export interface PendingSetup<P extends JsonValue> {
    state: string;
    claim: SetupClaimContext;
    request: ConnectorSetupRequest;
    payload: P;
    browserNonce?: string;
    expiresAt: Date;
}
export interface PendingSetupLifecycleOptions {
    capacity?: number;
    ttlMs?: number;
    maxPayloadBytes?: number;
    now?: () => number;
    token?: () => string;
}
export declare class PendingSetupLifecycle<P extends JsonValue> {
    #private;
    constructor(options?: PendingSetupLifecycleOptions);
    create(input: {
        claim: SetupClaimContext;
        request: ConnectorSetupRequest;
        payload: P;
        browserNonceRequired?: boolean;
    }): PendingSetup<P>;
    claim(state: string, browserNonce?: string): PendingSetup<P>;
    /** Re-arms a claimed multi-step flow with new provider payload and optional browser binding. */
    transition(state: string, payload: P, options?: {
        browserNonce?: string;
        browserNonceRequired?: boolean;
    }): PendingSetup<P>;
    remove(state: string): boolean;
    private get;
    private prune;
    private deleteEntry;
    private uniqueToken;
    private scope;
    private publicEntry;
}
export declare function setupBrowserNonceMatches(expected: string, supplied: string | undefined): boolean;
export declare class SealedSetupStateError extends Error {
    constructor();
}
export interface SealedSetupState<P extends JsonValue> {
    claim: SetupClaimContext;
    callSecret: string;
    returnToken: string;
    installationSecret?: string;
    browserNonce: string;
    payload: P;
    issuedAt: Date;
    expiresAt: Date;
}
export interface SealedSetupStateCodecOptions<P extends JsonValue> {
    key: Uint8Array;
    validatePayload(value: unknown): value is P;
    ttlMs?: number;
    maxTokenBytes?: number;
    maxPayloadBytes?: number;
    now?: () => number;
    random?: (bytes: number) => Uint8Array;
}
export declare class SealedSetupStateCodec<P extends JsonValue> {
    #private;
    constructor(options: SealedSetupStateCodecOptions<P>);
    seal(input: {
        claim: SetupClaimContext;
        request: ConnectorSetupRequest;
        browserNonce: string;
        payload: P;
    }): string;
    open(token: string): SealedSetupState<P>;
}
export declare const ERIK_BROWSER_RETURN_HEADER = "X-Erik-Browser-Return";
export declare function setupCompletionHeaders(returnToken: string): Record<string, string>;
