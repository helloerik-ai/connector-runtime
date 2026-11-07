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
    resource: { idParameter: string } | { fixedId: string } | { referenceParameter: string }
        | { list: { parentParameter?: string } };
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
    skill?: { name: string; description: string; instructions: string };
    resources?: ConnectorResourceManifest[];
    tools: ConnectorToolManifest[];
}

export class ConnectorManifestError extends Error {
    override name = 'ConnectorManifestError';
}

const TOOL_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const ACTION_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const RESOURCE_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
const SKILL_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const LEVELS = new Set<Level>(['read', 'prepare', 'change', 'irreversible']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_TOOL_NAMES = new Set(['current_time', 'list_people', 'give_access', 'load_skill', 'propose_skill']);
const RESOURCE_SEGMENT = /^[A-Za-z0-9_:@-][A-Za-z0-9._:@-]*$/;

const record = (value: unknown): Record<string, unknown> | undefined =>
    value && !Array.isArray(value) && typeof value === 'object' ? value as Record<string, unknown> : undefined;

function text(value: unknown, name: string, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) {
        throw new ConnectorManifestError(`Invalid connector manifest ${name}`);
    }
    return value;
}

function safeJson(value: unknown, depth = 0): void {
    if (depth > 20) throw new ConnectorManifestError('Connector manifest parameters are too deeply nested');
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
        for (const item of value) safeJson(item, depth + 1);
        return;
    }
    for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.has(key)) throw new ConnectorManifestError('Connector manifest parameters contain a reserved key');
        safeJson(item, depth + 1);
    }
}

/** Matches the canonical resource-id rule enforced by Erik's permission gateway. */
export function validConnectorResourceId(id: unknown): id is string {
    return typeof id === 'string' && id.length >= 1 && id.length <= 300
        && id.split('/').every(segment => RESOURCE_SEGMENT.test(segment) && segment !== '..');
}

export function parseConnectorManifest(value: unknown): ConnectorManifest {
    const root = record(value);
    if (!root || (root.version !== 1 && root.version !== 2) || !Array.isArray(root.tools) || root.tools.length > 50) {
        throw new ConnectorManifestError('Invalid connector manifest');
    }
    const version = root.version;
    const name = text(root.name, 'name', 120);
    const skill = root.skill === undefined ? undefined : record(root.skill);
    if (root.skill !== undefined && !skill) throw new ConnectorManifestError('Invalid connector manifest skill');
    const parsedSkill = skill ? {
        name: text(skill.name, 'skill name', 64),
        description: text(skill.description, 'skill description', 500),
        instructions: text(skill.instructions, 'skill instructions', 50_000),
    } : undefined;
    if (parsedSkill && !SKILL_NAME.test(parsedSkill.name)) {
        throw new ConnectorManifestError('Invalid connector manifest skill name');
    }

    const resources = root.resources;
    if ((version === 1 && resources !== undefined) || (version === 2 && (!Array.isArray(resources) || resources.length > 50))) {
        throw new ConnectorManifestError('Invalid connector manifest resources');
    }
    const resourceTypes = new Set<string>();
    const parsedResources: ConnectorResourceManifest[] | undefined = version === 2 ? (resources as unknown[]).map((item, index) => {
        const resource = record(item);
        if (!resource || Object.keys(resource).some(key => !['type', 'label', 'maxAgeSeconds', 'supportsSubtree'].includes(key))) {
            throw new ConnectorManifestError(`Invalid connector manifest resource type ${index + 1}`);
        }
        const parsed: ConnectorResourceManifest = {
            type: text(resource.type, 'resource type', 120),
            label: text(resource.label, 'resource label', 120),
            maxAgeSeconds: resource.maxAgeSeconds as number,
            supportsSubtree: resource.supportsSubtree as boolean,
        };
        if (!RESOURCE_TYPE.test(parsed.type) || resourceTypes.has(parsed.type)
            || !Number.isInteger(parsed.maxAgeSeconds) || parsed.maxAgeSeconds < 1 || parsed.maxAgeSeconds > 30 * 24 * 60 * 60
            || typeof parsed.supportsSubtree !== 'boolean') {
            throw new ConnectorManifestError(`Invalid connector manifest resource type ${index + 1}`);
        }
        resourceTypes.add(parsed.type);
        return parsed;
    }) : undefined;

    const names = new Set<string>();
    const tools = root.tools.map((item, index): ConnectorToolManifest => {
        const tool = record(item);
        const action = record(tool?.action);
        const resource = record(tool?.resource);
        const parameters = record(tool?.parameters);
        if (!tool || !action || !resource || !parameters || parameters.type !== 'object' || !record(parameters.properties)) {
            throw new ConnectorManifestError(`Invalid connector manifest tool ${index + 1}`);
        }
        const kinds = ['fixedId', 'idParameter', 'referenceParameter', 'list'].filter(key => Object.hasOwn(resource, key));
        if (kinds.length !== 1) throw new ConnectorManifestError(`Invalid connector manifest resource ${index + 1}`);
        let parsedResource: ConnectorToolManifest['resource'];
        if (kinds[0] === 'fixedId') parsedResource = { fixedId: text(resource.fixedId, 'fixed resource id', 300) };
        else if (kinds[0] === 'idParameter') parsedResource = { idParameter: text(resource.idParameter, 'resource id parameter', 64) };
        else if (kinds[0] === 'referenceParameter') parsedResource = { referenceParameter: text(resource.referenceParameter, 'resource reference parameter', 64) };
        else {
            const list = record(resource.list);
            if (!list || Object.keys(list).some(key => key !== 'parentParameter')) {
                throw new ConnectorManifestError(`Invalid connector manifest listing ${index + 1}`);
            }
            parsedResource = { list: {
                ...(list.parentParameter !== undefined && { parentParameter: text(list.parentParameter, 'listing parent parameter', 64) }),
            } };
        }
        const parsed: ConnectorToolManifest = {
            name: text(tool.name, 'tool name', 64),
            label: text(tool.label, 'tool label', 120),
            description: text(tool.description, 'tool description', 2_000),
            parameters,
            auth: tool.auth as 'connection',
            action: {
                name: text(action.name, 'action name', 120),
                level: action.level as Level,
                resourceType: text(action.resourceType, 'resource type', 120),
                ...(action.approval === 'always' && { approval: 'always' as const }),
            },
            resource: parsedResource,
        };
        if (!TOOL_NAME.test(parsed.name) || names.has(parsed.name) || RESERVED_TOOL_NAMES.has(parsed.name)) {
            throw new ConnectorManifestError('Invalid, duplicate or reserved connector tool name');
        }
        if (parsed.auth !== 'connection') throw new ConnectorManifestError(`Invalid connector auth for ${parsed.name}`);
        if (!ACTION_NAME.test(parsed.action.name) || !LEVELS.has(parsed.action.level)
            || !RESOURCE_TYPE.test(parsed.action.resourceType)
            || (action.approval !== undefined && action.approval !== 'always')) {
            throw new ConnectorManifestError(`Invalid connector action for ${parsed.name}`);
        }
        if (('referenceParameter' in parsed.resource || 'list' in parsed.resource)
            && (version !== 2 || !resourceTypes.has(parsed.action.resourceType))) {
            throw new ConnectorManifestError(`Resource-aware tool ${parsed.name} needs a declared resource type`);
        }
        if ('fixedId' in parsed.resource) {
            if (!validConnectorResourceId(parsed.resource.fixedId)) {
                throw new ConnectorManifestError(`Invalid fixed resource for ${parsed.name}`);
            }
        } else if ('idParameter' in parsed.resource || 'referenceParameter' in parsed.resource) {
            const properties = parameters.properties as Record<string, unknown>;
            const parameter = 'idParameter' in parsed.resource ? parsed.resource.idParameter : parsed.resource.referenceParameter;
            const resourceParameter = record(properties[parameter]);
            if (!resourceParameter || resourceParameter.type !== 'string') {
                throw new ConnectorManifestError(`Resource parameter for ${parsed.name} must be a string`);
            }
        } else if (parsed.resource.list.parentParameter !== undefined) {
            const properties = parameters.properties as Record<string, unknown>;
            const parentParameter = record(properties[parsed.resource.list.parentParameter]);
            if (!parentParameter || parentParameter.type !== 'string') {
                throw new ConnectorManifestError(`Listing parent parameter for ${parsed.name} must be a string`);
            }
        }
        if (Object.hasOwn(parameters.properties as Record<string, unknown>, 'connection')) {
            throw new ConnectorManifestError(`Connector tool ${parsed.name} uses reserved parameter connection`);
        }
        safeJson(parameters);
        names.add(parsed.name);
        return parsed;
    });
    return { version, name, ...(parsedSkill && { skill: parsedSkill }), ...(parsedResources && { resources: parsedResources }), tools };
}
