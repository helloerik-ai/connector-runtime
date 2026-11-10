# `@helloerik-ai/connector-runtime`

Public ESM TypeScript runtime contract for Erik connectors. It provides the authoritative connector manifest v1 and v2 parser, authenticated call-header parsing, connector registration, and the exclusive credential-lease client.

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

`ConnectorManifest` is a discriminated union of `ConnectorManifestV1` and `ConnectorManifestV2`; the matching version-specific tool types are also exported. `parseConnectorManifest` preserves the version-specific return type when given a typed manifest while still accepting `unknown` input for boundary validation. It validates manifest limits, names, actions, JSON-schema safety, reserved parameters, and resource identifiers. It does not fetch manifests over the network.

Manifest v2 adds synchronized resource-type declarations. Tools can use `resource.referenceParameter` for local human-reference resolution, `resource.list` for a local permission-filtered listing, or `resource.search` for local catalogue search. All three modes must name a declared resource type. Manifest v1 remains unchanged.

A manifest v2 search declaration has the exact shape `resource: { search: { queryParameter: string } }`; it is not part of the manifest v1 public type. `queryParameter` names a top-level string property in the tool's JSON schema. The declaration describes local catalogue discovery only: the runtime validates and returns it but does not search a provider or define any transport behavior.

## Authenticated Calls

Pass Node's request headers, or a web `Headers` object, and the connector id configured by the operator:

```ts
import { parseConnectorCallHeaders } from '@helloerik-ai/connector-runtime';

const call = parseConnectorCallHeaders(request.headers, config.connectorId);
```

The result includes the authenticated connector, organization and connection ids, one-use call secret, stable invocation id, absolute deadline and an abort signal for provider work. Missing, empty, repeated, combined multi-valued, or wrong-connector authentication headers throw `ConnectorCallHeaderError` with HTTP status `401`. Invalid invocation metadata is `400`; an expired deadline is `408`.

Pass `call.signal` to every provider request. Mutating provider calls should use `call.invocationId` as their idempotency key where the provider supports one. A connector must settle or classify dispatched work before `call.deadline`; it must not report definitive failure when the provider outcome is unknown.

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

The client deliberately does not renew leases. Current Erik connector calls finish within the credential service's 60-second lease. Pass the parsed invocation deadline and signal to `withCredential`; lease acquisition then stops at that earlier deadline.

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
        return callProvider(refreshed, { signal: call.signal, invocationId: call.invocationId });
    },
    { deadline: call.deadline, signal: call.signal },
);
```

`store` uses the same lease protocol for OAuth completion. When provider setup must happen before a credential becomes usable, use `storePrepared(orgId, connectionId, callSecret, credential, prepare, options?)`. It acquires and consumes the tuple-bound setup capability first, holds the exclusive lease while `prepare` runs, and stores the new credential only after `prepare` succeeds. The callback cannot access an existing credential. Pass the invocation deadline and signal in `options`; preparation should use that signal for provider work.

Lease release is best-effort in a `finally` block and never replaces the provider, preparation, or storage error. `CredentialClientError.code` and `status` allow server code to map failures without comparing user-facing messages.

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify
npm pack --dry-run
```

Run verification from a clean worktree so the result cannot depend on uncommitted files or existing build output. Inspect `npm pack --dry-run` before updating a connector's pinned runtime commit.
