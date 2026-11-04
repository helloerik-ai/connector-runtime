import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    ConnectorManifestError,
    parseConnectorManifest,
    validConnectorResourceId,
    type ConnectorManifest,
} from '../src/index.js';

const manifest = (): ConnectorManifest => ({
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

test('refuses malformed roots, tool identities, actions, auth and resource declarations', () => {
    const cases: unknown[] = [
        null,
        { ...manifest(), version: 2 },
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
