import {
    parseConnectorManifest,
    type ConnectorManifestV1,
    type ConnectorManifestV2,
    type ConnectorToolManifestV1,
} from '../src/index.js';

const v1Tool: ConnectorToolManifestV1 = {
    name: 'example_get',
    label: 'Get example',
    description: 'Gets one example',
    parameters: { type: 'object', properties: { exampleId: { type: 'string' } } },
    auth: 'connection',
    action: { name: 'example.items.read', level: 'read', resourceType: 'example.item' },
    resource: { idParameter: 'exampleId' },
};

const v1: ConnectorManifestV1 = { version: 1, name: 'Example', tools: [v1Tool] };
const parsedV1 = parseConnectorManifest(v1);
// @ts-expect-error Manifest v1 resources cannot declare search.
parsedV1.tools[0]!.resource.search;

const invalidV1Tool: ConnectorToolManifestV1 = {
    ...v1Tool,
    // @ts-expect-error Search is a manifest v2 resource kind.
    resource: { search: { queryParameter: 'query' } },
};
void invalidV1Tool;

const v2: ConnectorManifestV2 = {
    version: 2,
    name: 'Example',
    resources: [{ type: 'example.item', label: 'Example', maxAgeSeconds: 300, supportsSubtree: false }],
    tools: [{
        ...v1Tool,
        name: 'example_search',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        resource: { search: { queryParameter: 'query' } },
    }],
};
const parsedV2 = parseConnectorManifest(v2);
const searchResource = parsedV2.tools[0]!.resource;
if ('search' in searchResource) searchResource.search.queryParameter satisfies string;

const directV2 = parseConnectorManifest({
    version: 2,
    name: 'Example',
    resources: [],
    tools: [],
});
directV2.resources satisfies typeof directV2.resources;
