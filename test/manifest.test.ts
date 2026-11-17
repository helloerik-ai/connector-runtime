import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ConnectorManifestError,
    parseConnectorManifest,
    validConnectorResourceId,
    type ConnectorManifestV1,
    type ConnectorManifestV2,
} from '../src/index.js';

const manifest = (): ConnectorManifestV1 => ({
    version: 1,
    name: 'Example connector',
    skill: { name: 'example-skill', description: 'Use the example system', instructions: 'Prefer exact identifiers.' },
    tools: [{
        name: 'example_get',
        label: 'Get example',
        description: 'Gets one example',
        parameters: {
            type: 'object',
            properties: { exampleId: { type: 'string' } },
            required: ['exampleId'],
            additionalProperties: false,
        },
        auth: 'connection',
        action: { name: 'example.items.read', level: 'read', resourceType: 'example.item' },
        resource: { idParameter: 'exampleId' },
    }],
});

test('parses and returns a canonical ConnectorManifest v1', () => {
    assert.deepEqual(parseConnectorManifest(manifest()), manifest());
    const fixed = manifest();
    fixed.tools[0]!.resource = { fixedId: 'invoices/open:@2026' };
    assert.deepEqual(parseConnectorManifest(fixed), fixed);
});

test('parses bounded browser routes and exact redirect origins in v1 and v2 manifests', () => {
    const browser = {
        routes: [
            { path: '/setup', method: 'POST' as const, trust: 'setup' as const },
            { path: '/oauth/callback', method: 'GET' as const, trust: 'provider' as const },
            { path: '/continue', method: 'GET' as const, trust: 'browser' as const },
        ],
        redirectOrigins: ['https://accounts.example.com', 'http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'],
    };
    const v1 = { ...manifest(), browser };
    assert.deepEqual(parseConnectorManifest(v1), v1);
    const v2 = { version: 2 as const, name: 'Example', resources: [], tools: [], browser };
    assert.deepEqual(parseConnectorManifest(v2), v2);
});

test('refuses unsafe, ambiguous, unsupported and duplicate browser routes', () => {
    const routes: unknown[] = [
        { path: 'setup', method: 'POST', trust: 'setup' },
        { path: '/setup/', method: 'POST', trust: 'setup' },
        { path: '/setup/*', method: 'POST', trust: 'setup' },
        { path: '/setup.json', method: 'POST', trust: 'setup' },
        { path: '/setup/../callback', method: 'POST', trust: 'setup' },
        { path: '/setup/%2fcallback', method: 'POST', trust: 'setup' },
        { path: '/setup/%5Ccallback', method: 'POST', trust: 'setup' },
        { path: '/setup', method: 'PUT', trust: 'setup' },
        { path: '/setup', method: ['POST'], trust: 'setup' },
        { path: '/setup', method: 'POST', trust: 'admin' },
        { path: '/setup', method: 'POST', trust: 'setup', extra: true },
        { path: `/${'x'.repeat(201)}`, method: 'POST', trust: 'setup' },
    ];
    for (const route of routes) {
        assert.throws(() => parseConnectorManifest({ ...manifest(), browser: { routes: [route], redirectOrigins: [] } }),
            /browser route/);
    }
    const route = { path: '/setup', method: 'POST', trust: 'setup' };
    assert.throws(() => parseConnectorManifest({ ...manifest(), browser: { routes: [route, route], redirectOrigins: [] } }),
        /duplicate.*browser route/);
    assert.throws(() => parseConnectorManifest({ ...manifest(), browser: {
        routes: new Array(31).fill(route), redirectOrigins: [],
    } }), /browser declaration/);
});

test('requires exactly POST for setup trust and permits at most one setup route', () => {
    const getSetup = { path: '/setup', method: 'GET', trust: 'setup' };
    assert.throws(() => parseConnectorManifest({ ...manifest(), browser: { routes: [getSetup], redirectOrigins: [] } }),
        /browser route/);
    assert.throws(() => parseConnectorManifest({ ...manifest(), browser: {
        routes: [
            { path: '/setup', method: 'POST', trust: 'setup' },
            { path: '/setup-again', method: 'POST', trust: 'setup' },
        ],
        redirectOrigins: [],
    } }), /browser route/);
    for (const malformed of [
        { path: '/setup', trust: 'setup' },
        { path: '/setup', method: 'POST' },
        { path: '/setup', method: ['POST'], trust: 'setup' },
    ]) {
        assert.throws(() => parseConnectorManifest({ ...manifest(), browser: { routes: [malformed], redirectOrigins: [] } }),
            /browser route/);
    }
});

test('refuses non-origin, non-HTTPS remote, duplicate and unbounded browser redirect origins', () => {
    const invalid = [
        'http://accounts.example.com',
        'https://accounts.example.com/path',
        'https://accounts.example.com/',
        'https://user@accounts.example.com',
        'https://*.example.com',
        'https://accounts.example.com?next=x',
        'http://0.0.0.0:3000',
        'http://localhost.example.com:3000',
        `https://${'x'.repeat(301)}`,
    ];
    for (const origin of invalid) {
        assert.throws(() => parseConnectorManifest({ ...manifest(), browser: { routes: [], redirectOrigins: [origin] } }),
            /redirect origin/);
    }
    assert.throws(() => parseConnectorManifest({ ...manifest(), browser: {
        routes: [], redirectOrigins: ['https://accounts.example.com', 'https://accounts.example.com'],
    } }), /duplicate.*redirect origin/);
    assert.throws(() => parseConnectorManifest({ ...manifest(), browser: {
        routes: [], redirectOrigins: new Array(31).fill('https://accounts.example.com'),
    } }), /browser declaration/);
    assert.throws(() => parseConnectorManifest({ ...manifest(), browser: { routes: [], redirectOrigins: [], extra: true } }),
        /browser declaration/);
});

test('accepts and canonicalizes a v1 resource with an unrelated search property', () => {
    for (const validResource of [{ idParameter: 'exampleId' }, { fixedId: 'example' }]) {
        const compatibilityInput = manifest() as unknown as Record<string, unknown>;
        const tools = compatibilityInput.tools as Array<Record<string, unknown>>;
        tools[0]!.resource = { ...validResource, search: { unrelated: true } };
        const expected = manifest();
        expected.tools[0]!.resource = validResource;

        assert.deepEqual(parseConnectorManifest(compatibilityInput), expected);
    }
});

test('refuses mixed known v1 and v2 resource declarations in manifest v1', () => {
    for (const extra of [{ referenceParameter: 'exampleId' }, { list: {} }]) {
        for (const validResource of [{ idParameter: 'exampleId' }, { fixedId: 'example' }]) {
            const input = manifest() as unknown as Record<string, unknown>;
            const tools = input.tools as Array<Record<string, unknown>>;
            tools[0]!.resource = { ...validResource, ...extra };
            assert.throws(() => parseConnectorManifest(input), /manifest resource/);
        }
    }
});

test('parses resource-aware resolution, local listing and local catalogue search tools in manifest v2', () => {
    const resourceAware: ConnectorManifestV2 = {
        version: 2,
        name: 'Google Drive',
        resources: [{ type: 'drive.item', label: 'Drive item', maxAgeSeconds: 300, supportsSubtree: true }],
        tools: [{
            name: 'drive_read', label: 'Read file', description: 'Read one file.', auth: 'connection',
            parameters: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'] },
            action: { name: 'drive.read', level: 'read', resourceType: 'drive.item' },
            resource: { referenceParameter: 'file' },
        }, {
            name: 'drive_list', label: 'List files', description: 'List accessible files.', auth: 'connection',
            parameters: { type: 'object', properties: { folder: { type: 'string' } } },
            action: { name: 'drive.read', level: 'read', resourceType: 'drive.item' },
            resource: { list: { parentParameter: 'folder' } },
        }, {
            name: 'drive_search', label: 'Search files', description: 'Search accessible files.', auth: 'connection',
            parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
            action: { name: 'drive.read', level: 'read', resourceType: 'drive.item' },
            resource: { search: { queryParameter: 'query' } },
        }],
    };
    assert.deepEqual(parseConnectorManifest(structuredClone(resourceAware)), resourceAware);
    assert.throws(() => parseConnectorManifest({ ...resourceAware, resources: undefined }), /resources/);
    assert.throws(() => parseConnectorManifest({ ...resourceAware, resources: [{ ...resourceAware.resources![0], maxAgeSeconds: 0 }] }), /resource type/);
    assert.throws(() => parseConnectorManifest({ ...resourceAware, tools: [{ ...resourceAware.tools[0],
        resource: { referenceParameter: 'missing' } }] }), /must be a string/);
    assert.throws(() => parseConnectorManifest({ ...resourceAware, tools: [{ ...resourceAware.tools[0],
        action: { ...resourceAware.tools[0]!.action, resourceType: 'drive.undeclared' } }] }), /declared resource type/);
});

test('refuses invalid local catalogue search declarations', () => {
    const searchTool = {
        ...manifest().tools[0],
        name: 'example_search',
        parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } } },
        resource: { search: { queryParameter: 'query' } },
    };
    const v2 = {
        version: 2,
        name: 'Example connector',
        resources: [{ type: 'example.item', label: 'Example', maxAgeSeconds: 300, supportsSubtree: false }],
        tools: [searchTool],
    };

    assert.throws(() => parseConnectorManifest({ ...v2, version: 1, resources: undefined }), /manifest resource/);
    assert.throws(() => parseConnectorManifest({ ...v2, resources: [] }), /declared resource type/);
    assert.throws(() => parseConnectorManifest({ ...v2, tools: [{ ...searchTool,
        resource: { search: { queryParameter: 'missing' } } }] }), /must be a string/);
    assert.throws(() => parseConnectorManifest({ ...v2, tools: [{ ...searchTool,
        resource: { search: { queryParameter: 'limit' } } }] }), /must be a string/);
    assert.throws(() => parseConnectorManifest({ ...v2, tools: [{ ...searchTool,
        resource: { search: { queryParameter: 'query', extra: true } } }] }), /manifest search/);
    assert.throws(() => parseConnectorManifest({ ...v2, tools: [{ ...searchTool,
        resource: { search: { queryParameter: 'query' }, extra: true } }] }), /manifest search/);
    assert.throws(() => parseConnectorManifest({ ...v2, tools: [{ ...searchTool,
        resource: { search: 'query' } }] }), /manifest search/);
});

test('refuses malformed roots, tool identities, actions, auth and resource declarations', () => {
    const cases: unknown[] = [
        null,
        { ...manifest(), version: 2, resources: undefined },
        { ...manifest(), tools: new Array(51).fill(manifest().tools[0]) },
        { ...manifest(), skill: { name: 'Bad Name', description: 'x', instructions: 'x' } },
        { ...manifest(), tools: [{ ...manifest().tools[0], name: 'A' }] },
        { ...manifest(), tools: [manifest().tools[0], manifest().tools[0]] },
        { ...manifest(), tools: [{ ...manifest().tools[0], auth: 'none' }] },
        { ...manifest(), tools: [{ ...manifest().tools[0], action: { name: 'read', level: 'read', resourceType: 'example.item' } }] },
        { ...manifest(), tools: [{ ...manifest().tools[0], action: { name: 'example.read', level: 'admin', resourceType: 'example.item' } }] },
        { ...manifest(), tools: [{ ...manifest().tools[0], resource: { fixedId: 'fixed', idParameter: 'exampleId' } }] },
        { ...manifest(), tools: [{ ...manifest().tools[0], resource: {} }] },
        { ...manifest(), tools: [{ ...manifest().tools[0], resource: { idParameter: 'missing' } }] },
    ];
    for (const value of cases) assert.throws(() => parseConnectorManifest(value), ConnectorManifestError);
});

test('refuses names reserved for Erik built-in tools', () => {
    for (const name of ['current_time', 'list_people', 'give_access', 'load_skill', 'propose_skill']) {
        const value = manifest();
        value.tools[0]!.name = name;
        assert.throws(() => parseConnectorManifest(value), ConnectorManifestError);
    }
});

test('refuses non-canonical fixed ids and accepts the permission gateway resource-id boundary', () => {
    assert.equal(validConnectorResourceId('a'), true);
    assert.equal(validConnectorResourceId('A_1:@-z/path.with.dots'), true);
    assert.equal(validConnectorResourceId('x'.repeat(300)), true);
    for (const id of ['', '/a', 'a/', 'a//b', '.', '..', 'a/../b', 'a b', 'x'.repeat(301)]) {
        assert.equal(validConnectorResourceId(id), false, id);
        const value = manifest();
        value.tools[0]!.resource = { fixedId: id };
        assert.throws(() => parseConnectorManifest(value), ConnectorManifestError);
    }
});

test('refuses reserved parameter names, prototype keys and excessive JSON-schema depth', () => {
    const connection = manifest();
    (connection.tools[0]!.parameters.properties as Record<string, unknown>).connection = { type: 'string' };
    assert.throws(() => parseConnectorManifest(connection), /reserved parameter connection/);

    const reserved = manifest();
    reserved.tools[0]!.parameters = JSON.parse('{"type":"object","properties":{"exampleId":{"type":"string"},"safe":{"__proto__":true}}}');
    assert.throws(() => parseConnectorManifest(reserved), /reserved key/);

    const deep = manifest();
    let cursor = deep.tools[0]!.parameters;
    for (let index = 0; index < 22; index++) {
        const child: Record<string, unknown> = {};
        cursor.child = child;
        cursor = child;
    }
    assert.throws(() => parseConnectorManifest(deep), /deeply nested/);
});
