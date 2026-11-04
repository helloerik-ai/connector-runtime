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
    resource: { idParameter: string } | { fixedId: string };
}

export interface ConnectorManifest {
    version: 1;
    name: string;
    skill?: { name: string; description: string; instructions: string };
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
    if (!root || root.version !== 1 || !Array.isArray(root.tools) || root.tools.length > 50) {
        throw new ConnectorManifestError('Invalid connector manifest');
    }
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

    const names = new Set<string>();
    const tools = root.tools.map((item, index): ConnectorToolManifest => {
        const tool = record(item);
        const action = record(tool?.action);
        const resource = record(tool?.resource);
        const parameters = record(tool?.parameters);
        if (!tool || !action || !resource || !parameters || parameters.type !== 'object' || !record(parameters.properties)) {
            throw new ConnectorManifestError(`Invalid connector manifest tool ${index + 1}`);
        }
        const hasFixedResource = Object.hasOwn(resource, 'fixedId');
        const hasResourceParameter = Object.hasOwn(resource, 'idParameter');
        if (hasFixedResource === hasResourceParameter) {
            throw new ConnectorManifestError(`Invalid connector manifest resource ${index + 1}`);
        }
        const parsedResource: ConnectorToolManifest['resource'] = hasFixedResource
            ? { fixedId: text(resource.fixedId, 'fixed resource id', 300) }
            : { idParameter: text(resource.idParameter, 'resource id parameter', 64) };
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
        if ('fixedId' in parsed.resource) {
            if (!validConnectorResourceId(parsed.resource.fixedId)) {
                throw new ConnectorManifestError(`Invalid fixed resource for ${parsed.name}`);
            }
        } else {
            const properties = parameters.properties as Record<string, unknown>;
            const resourceParameter = record(properties[parsed.resource.idParameter]);
            if (!resourceParameter || resourceParameter.type !== 'string') {
                throw new ConnectorManifestError(`Resource parameter for ${parsed.name} must be a string`);
            }
        }
        if (Object.hasOwn(parameters.properties as Record<string, unknown>, 'connection')) {
            throw new ConnectorManifestError(`Connector tool ${parsed.name} uses reserved parameter connection`);
        }
        safeJson(parameters);
        names.add(parsed.name);
        return parsed;
    });
    return { version: 1, name, ...(parsedSkill && { skill: parsedSkill }), tools };
}
