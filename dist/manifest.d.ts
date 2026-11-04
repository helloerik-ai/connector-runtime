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
    /** Version 1 uses stable ids directly. Version 2 may resolve a human reference or list synchronized resources locally. */
    resource: {
        idParameter: string;
    } | {
        fixedId: string;
    } | {
        referenceParameter: string;
    } | {
        list: {
            parentParameter?: string;
        };
    };
}
export interface ConnectorResourceManifest {
    type: string;
    label: string;
    maxAgeSeconds: number;
    supportsSubtree: boolean;
}
export interface ConnectorManifest {
    version: 1 | 2;
    name: string;
    skill?: {
        name: string;
        description: string;
        instructions: string;
    };
    resources?: ConnectorResourceManifest[];
    tools: ConnectorToolManifest[];
}
export declare class ConnectorManifestError extends Error {
    name: string;
}
/** Matches the canonical resource-id rule enforced by Erik's permission gateway. */
export declare function validConnectorResourceId(id: unknown): id is string;
export declare function parseConnectorManifest(value: unknown): ConnectorManifest;
