# Contributing

Thanks for helping! badland-brain aims to stay small, predictable and safe to point agents at.

## Ground rules

- **Few runtime dependencies.** Add one only when the standard library or an existing dependency
  cannot do the job, and say why in the pull request.
- **Secrets never surface.** No key, token, body or query in a log line, an error message, a test
  snapshot or a fixture. A new code path that handles caller text goes through the secret-shape gate.
- **Provenance is set by code.** Origin class, tier, author and history are derived from the write
  path; never let a request field set them.
- **Every behavior has a test.** Bug fixes come with the test that would have caught them; changes
  to the store keep its concurrency and lineage tests green.
- **Synthetic data only.** Test data and eval fixtures are invented: no real names, hosts, paths,
  notes or memories.

## Development

```sh
git clone https://github.com/coletebou/badland-brain && cd badland-brain
npm ci
npm run typecheck
npm test               # unit and integration tests (in-memory MongoDB, downloaded on first run)
npm run test:e2e       # builds, then drives the real server process over MCP
npm run build
```

Tests that need MongoDB start their own in-memory server through `src/test-support/mongo.ts`;
`src/test-support/brain.ts` gives the small fake-embedder configuration most tests use. The Drover
plugin's tests live in `integrations/drover/test/` and run with `npm test`.

## Issues and pull requests

Open an issue with the bug or feature form; report vulnerabilities privately, as [SECURITY.md](SECURITY.md)
describes. A pull request fills in the template's Summary, Testing and Evidence sections.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`,
`refactor:`, `chore:`.
