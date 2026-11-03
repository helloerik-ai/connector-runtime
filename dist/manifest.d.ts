export type Level = 'read' | 'prepare' | 'change' | 'irreversible';
export type ConnectorActionLevel = Level;
export interface ConnectorToolManifest {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    auth: 'connection';
    action: {
        name: string;
        level: Level;
        resourceType: string;
        approval?: 'always';
    };
    /** A protected resource identified either by one top-level string argument or by a manifest constant. */
    resource: {
        idParameter: string;
    } | {
        fixedId: string;
    };
}
export interface ConnectorManifest {
    version: 1;
    name: string;
    skill?: {
        name: string;
        description: string;
        instructions: string;
    };
    tools: ConnectorToolManifest[];
}
export declare class ConnectorManifestError extends Error {
    name: string;
}
/** Matches the canonical resource-id rule enforced by Erik's permission gateway. */
export declare function validConnectorResourceId(id: unknown): id is string;
export declare function parseConnectorManifest(value: unknown): ConnectorManifest;
