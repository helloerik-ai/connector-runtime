export type Level = 'read' | 'prepare' | 'change' | 'irreversible';
export type ConnectorActionLevel = Level;
interface ConnectorToolManifestBase {
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
}
export interface ConnectorToolManifestV1 extends ConnectorToolManifestBase {
    resource: {
        idParameter: string;
    } | {
        fixedId: string;
    };
}
export interface ConnectorToolManifestV2 extends ConnectorToolManifestBase {
    resource: ConnectorToolManifestV1['resource'] | {
        referenceParameter: string;
    } | {
        list: {
            parentParameter?: string;
        };
    } | {
        search: {
            queryParameter: string;
        };
    };
}
export type ConnectorToolManifest = ConnectorToolManifestV1 | ConnectorToolManifestV2;
export interface ConnectorResourceManifest {
    type: string;
    label: string;
    maxAgeSeconds: number;
    supportsSubtree: boolean;
}
interface ConnectorManifestBase {
    name: string;
    skill?: {
        name: string;
        description: string;
        instructions: string;
    };
}
export interface ConnectorManifestV1 extends ConnectorManifestBase {
    version: 1;
    resources?: never;
    tools: ConnectorToolManifestV1[];
}
export interface ConnectorManifestV2 extends ConnectorManifestBase {
    version: 2;
    resources: ConnectorResourceManifest[];
    tools: ConnectorToolManifestV2[];
}
export type ConnectorManifest = ConnectorManifestV1 | ConnectorManifestV2;
export declare class ConnectorManifestError extends Error {
    name: string;
}
/** Matches the canonical resource-id rule enforced by Erik's permission gateway. */
export declare function validConnectorResourceId(id: unknown): id is string;
export declare function parseConnectorManifest(value: ConnectorManifestV1): ConnectorManifestV1;
export declare function parseConnectorManifest(value: ConnectorManifestV2): ConnectorManifestV2;
export declare function parseConnectorManifest(value: unknown): ConnectorManifest;
export {};
