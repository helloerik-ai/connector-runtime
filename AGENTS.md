# Contributor Instructions

This public repository provides `@helloerik-ai/connector-runtime`, the shared contract between Erik and separately deployed connectors. Consumers pin a full Git commit; the package is not published to npm.

## Compatibility

- Keep the package ESM-only and compatible with Node.js 24.15 or newer.
- Treat manifest validation and the credential lease sequence as security boundaries. Preserve refusal behavior and concurrency ordering, not only successful calls.
- Do not add credential lease renewal here while Erik connector calls have a 30-second overall timeout under a 60-second lease. End-to-end deadlines and any future renewal policy belong to the connector runtime lifecycle.
- Keep manifest parsing network-free. Erik fetches manifests from its operator-fixed registry domain.
- Never log connector registry secrets, call secrets, credential lease holders, or plaintext credentials.
- Add or update tests for every protocol change, including malformed and unauthorized inputs.

## Commands

Use pnpm 10.17.1:

```bash
pnpm verify
npm pack --dry-run
```

Commit updated `dist/` output with every source change. Before pushing, inspect the tarball and confirm it contains only compiled output, [`README.md`](README.md), [`LICENSE`](LICENSE), and package metadata.
