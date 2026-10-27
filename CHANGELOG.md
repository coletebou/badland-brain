# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-26

First public release.

### Server
- A stateless streamable-HTTP MCP endpoint at `/mcp` with seven tools: `brain_search`, `brain_get`,
  `brain_list`, `brain_context`, `brain_note`, `brain_supersede` and `brain_forget`.
- REST twins of the tools under `/api`, plus owner operations: bulk import with provenance,
  promotion into the curated tier, reindex, and retiring an import source.
- `GET /healthz` with the index's counts, embedding model and staleness.

### Memory
- MongoDB as the truth: verbatim Markdown entries with kinds, tiers (episodic, curated, review),
  namespaces, origin classes, importance and validity times.
- Supersede with compare-and-set on the content hash, history kept and readable; folding into an
  existing identical entry instead of duplicating it; soft-delete forget.
- A curated tier only the owner writes; `standing` facts served by `brain_context`; curated copies
  flagged `needs-review` or demoted when their source is forgotten or turns untrusted.

### Search
- A rebuildable SQLite index: FTS5 keyword search and sqlite-vec vector search fused by reciprocal
  rank, with recency, importance, one chunk per entry and maximal marginal relevance.
- Heading-aware chunking that never splits fenced code, and an embedding cache.
- Time-travel queries (`validAt`), kind and tier filters, keyword-only fallback while the embedding
  provider is down or the index is stale, and an in-process reindex that swaps the file live.
- Embedding providers: Gemini, any OpenAI-compatible endpoint, and an offline fake.

### Security
- Bearer keys with `read`, `agent` and `owner` roles, optional namespace confinement and expiry,
  stored as SHA-256 hashes in a hot-reloaded keys file or `BRAIN_KEYS`.
- A secret-shape gate on every write and every search query.
- Per-key request and write rate limits, body and argument size limits, and an optional cap on what
  agents may store.

### Tools
- The `badland-brain` command: `serve`, `keys mint|list|revoke`, `import`, `promote`, `supersede`,
  `forget`, `forget-source`, `reindex`, `health` and `eval`.
- Importers for Claude Code memory, Codex memory, OpenClaw workspaces and Markdown folders, with
  configurable exclusion terms and repo roots, oversized files split into parts that re-imports keep
  in step, and dry runs.
- A retrieval eval over a synthetic corpus: recall@5, MRR@5, abstention and revocation checks.
- A Drover plugin (`integrations/drover`) with `brain.*` ops and search kind `brain`.
- A Dockerfile and a Compose file with MongoDB.
