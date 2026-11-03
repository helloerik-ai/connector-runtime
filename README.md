# `@helloerik-ai/connector-runtime`

Public ESM TypeScript runtime contract for Erik connectors. It provides the authoritative connector manifest v1 parser, authenticated call-header parsing, connector registration, and the exclusive credential-lease client.

Requires Node.js 24.15 or newer.

## Install

```bash
pnpm add "@helloerik-ai/connector-runtime@git+https://github.com/helloerik-ai/connector-runtime.git#<full-commit-sha>"
```

Connector repositories pin a full runtime commit in `package.json` and their lockfile. Compiled `dist/` files are committed, so local and deployment installs do not need npm publication or package-install scripts. Upgrade by reviewing and pinning a newer runtime commit.

## Manifest

Validate the same manifest object served from `/.well-known/erik-connector.json` before exposing it:

```ts
import { parseConnectorManifest, type ConnectorManifest } from '@helloerik-ai/connector-runtime';

export const manifest = parseConnectorManifest({
    version: 1,
    name: 'Example',
    tools: [],
}) satisfies ConnectorManifest;
```

`parseConnectorManifest` validates manifest limits, names, actions, JSON-schema safety, reserved parameters, and resource identifiers. It does not fetch manifests over the network.

## Authenticated Calls

Pass Node's request headers, or a web `Headers` object, and the connector id configured by the operator:

```ts
import { parseConnectorCallHeaders } from '@helloerik-ai/connector-runtime';

const call = parseConnectorCallHeaders(request.headers, config.connectorId);
```

Missing, empty, repeated, combined multi-valued, or wrong-connector headers throw `ConnectorCallHeaderError` with HTTP status `401`.

## Registration

```ts
import { registerConnector } from '@helloerik-ai/connector-runtime';

await registerConnector({
    apiUrl: config.erikApiUrl,
    connectorId: config.connectorId,
    secret: config.registrationSecret,
});
```

Registration is the existing authenticated liveness signal and has a ten-second request timeout.

## Credentials

`CredentialClient` exchanges each one-time call secret for a 60-second exclusive lease. Reading, provider refresh work, replacement, and release all happen in that lease. A `409` during acquisition retries every 200 ms for up to ten seconds; `401` is reported as an expired or invalid call.

The client deliberately does not renew leases. Current Erik connector calls have a 30-second overall timeout and therefore finish within the credential service's 60-second lease. End-to-end call deadlines and any future renewal policy belong to the connector runtime lifecycle, not this credential client.

```ts
import { CredentialClient } from '@helloerik-ai/connector-runtime';

const credentials = new CredentialClient(config.erikApiUrl, config.connectorId, {
    messages: {
        notConnected: 'Example is not connected',
        replacementFailed: 'The refreshed Example login could not be saved',
    },
});

const result = await credentials.withCredential(
    call.orgId,
    call.connectionId,
    call.callSecret,
    async (credential, replace) => {
        const refreshed = await refreshIfNeeded(credential);
        if (refreshed !== credential) await replace(refreshed);
        return callProvider(refreshed);
    },
);
```

`store` uses the same lease protocol for OAuth completion. Lease release is best-effort in a `finally` block and never replaces the provider or storage error. `CredentialClientError.code` and `status` allow server code to map failures without comparing user-facing messages.

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify
npm pack --dry-run
```

Run verification from a clean worktree so the result cannot depend on uncommitted files or existing build output. Inspect `npm pack --dry-run` before updating a connector's pinned runtime commit.
