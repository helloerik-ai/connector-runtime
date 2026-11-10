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
