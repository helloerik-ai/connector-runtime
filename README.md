# `@helloerik-ai/connector-runtime`

Public ESM TypeScript runtime contract for Erik connectors. It provides the authoritative connector manifest v1 and v2 parser, authenticated call-header parsing, connector registration, setup claims, and the exclusive credential-lease client. Legacy browser-contract v1 signing remains available during migration.

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

Both manifest versions may declare browser routes:

```ts
browser: {
    version: 2,
    routes: [
        { path: '/setup', method: 'POST', trust: 'setup' },
        { path: '/oauth/callback', method: 'GET', trust: 'provider' },
    ],
    redirectOrigins: ['https://accounts.provider.example'],
}
```

`browser.version` selects the rolling-compatible browser transport contract. Missing `version` or `version: 1` is the legacy contract: Erik maps each declared public path to the connector's signed `/erik/browser/...` transport path. `version: 2` makes every declared path the connector's exact ordinary path; Erik forwards it unchanged. There is no separate target path.

Each declaration allows one exact `GET` or `POST` path and one trust class. A manifest may have at most one `setup` route and it must use `POST`; malformed setup declarations invalidate the manifest. `setup` requires Erik's authenticated setup handoff, `browser` is a connector-state-bound browser continuation, and `provider` is a provider callback whose connector state remains authoritative. Paths use canonical slash-separated alphanumeric, `_` and `-` segments; wildcards, dot segments, encoded separators and other ambiguous forms are refused. Redirects may target only listed exact HTTPS origins. Exact loopback HTTP origins on `localhost`, `127.0.0.1` or `[::1]` are allowed for local development.

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

const registration = await registerConnector({
    apiUrl: config.erikApiUrl,
    connectorId: config.connectorId,
    expectedDomain: new URL(config.publicUrl).host,
    secret: config.registrationSecret,
});
```

Registration is the existing authenticated liveness signal and has a ten-second request timeout. `apiUrl` must be an exact HTTPS origin; exact loopback HTTP origins are allowed for local development. Redirects are never followed. `expectedDomain` is the canonical host, including any port, from the connector's configured public URL. Registration refuses a response whose domain differs from it. The validated result contains `id` and `domain`. It optionally contains `browserProxySecret` for legacy browser-contract v1 connectors; v2 connectors do not receive or need it. Never send that legacy secret to a browser or log it.

## Legacy Browser Proxy Authentication

Browser contract v1 is retained only for rolling compatibility. Erik signs each v1 request it sends to a connector's internal `/erik/browser/...` namespace. Connectors verify the transport before invoking route code:

```ts
import { verifyConnectorBrowserRequest } from '@helloerik-ai/connector-runtime';

const browserRequest = verifyConnectorBrowserRequest({
    headers: request.headers,
    secret: registration.browserProxySecret!,
    connectorId: config.connectorId,
    method: request.method,
    path: url.pathname,
    query: url.search.slice(1),
    body: rawBody,
});
```

Pass `browserRequest.signal` to downstream work. The signed deadline is canonical ISO 8601 UTC, must be in the future, and can be no more than 60 seconds ahead.

The headers are `X-Erik-Browser-Connector`, `X-Erik-Browser-Request-Id`, `X-Erik-Browser-Deadline`, `X-Erik-Browser-Body-SHA256`, and `X-Erik-Browser-Signature`. The body digest and HMAC-SHA256 signature are lowercase hex. The HMAC input is these exact UTF-8 fields joined by one newline, with no final newline:

```text
<connector id>\n
<uppercase method>\n
<exact /erik/browser/... path>\n
<raw query without ?>\n
<lowercase hex SHA-256 body digest>\n
<unique request id>\n
<canonical deadline>
```

`signConnectorBrowserRequest` and `verifyConnectorBrowserRequest` are deprecated legacy-v1 APIs. Signing generates a unique request id and a 30-second deadline unless supplied by Erik. Verification uses strict singleton header parsing and constant-time signature comparison; it binds changes to the connector, method, path, raw query, body, request id, or deadline. This transport signature is not provider-operation authority. Connector state and one-use setup or credential capabilities remain responsible for authorization and replay resistance. Browser contract v2 uses ordinary connector paths and does not use these APIs.

## Credentials

`CredentialClient` exchanges each one-time call secret for a 60-second exclusive lease. Reading, provider refresh work, replacement, and release all happen in that lease. A `409` during acquisition retries every 200 ms for up to ten seconds; `401` is reported as an expired or invalid call.

For a browser-contract v2 setup route, call `claimSetup(orgId, connectionId, callSecret, setupAttempt, options?)` before creating connector state, setting cookies, redirecting, or starting provider work. It posts the existing call secret and setup attempt to the credential resource's `/claim` operation; it does not introduce another bearer token. A successful claim returns the strictly validated authoritative `{ orgId, connectionId, setupAttempt, expiresAt }` context. A `401` is `invalid-call`. Pass the setup request's deadline and signal so a claim cannot outlive it. The API owns the atomic issued-versus-claimed state transition; the runtime only exposes the validated operation.

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

`store(orgId, connectionId, callSecret, credential, options?)` uses the same lease protocol for OAuth completion. Pass the signed browser request's deadline and signal in `options` so lease acquisition and storage cannot outlive that request. When provider setup must happen before a credential becomes usable, use `storePrepared(orgId, connectionId, callSecret, credential, prepare, options?)`. It acquires and consumes the tuple-bound setup capability first, holds the exclusive lease while `prepare` runs, and stores the new credential only after `prepare` succeeds. The callback cannot access an existing credential. Preparation should use the same signal for provider work.

Lease release is best-effort in a `finally` block and never replaces the provider, preparation, or storage error. `CredentialClientError.code` and `status` allow server code to map failures without comparing user-facing messages.

## Development

```bash
pnpm install --frozen-lockfile
pnpm verify
npm pack --dry-run
```

Run verification from a clean worktree so the result cannot depend on uncommitted files or existing build output. Inspect `npm pack --dry-run` before updating a connector's pinned runtime commit.
