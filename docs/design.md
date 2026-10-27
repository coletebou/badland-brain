# Design

badland-brain is one shared, read-write memory that coding agents (Claude Code, Codex, ChatGPT and
any other MCP client) use to remember what they learned while working for one owner: decisions,
handoffs, gotchas, preferences and documents. This document records what the design rests on and
why each piece is the way it is. The [README](../README.md) covers how to run it.

## Goals and non-goals

Goals:

- One memory every agent reads and writes, over the Model Context Protocol, from any machine.
- Search that finds both exact identifiers and loosely phrased questions.
- Facts that can change without losing their history, and questions about what was true when.
- A small, trusted set of standing facts that every session starts with.
- Provenance on everything, so an agent can weigh what it reads back.

Non-goals:

- Replacing the agents' own memory features. Those keep running; the brain is the shared layer above
  them.
- Typed knowledge graphs, parametric memory, or a second database service. One MongoDB collection,
  one SQLite index file.
- Model-written summaries on the write path. Notes are stored as written.
- Rerankers on by default (see below).

## What the research settled

The original design started from a survey of memory benchmarks, memory architectures and retrieval
stacks. Its findings, with the sources it cited:

| Finding | Evidence cited | Consequence here |
|---|---|---|
| Verbatim text beats LLM-extracted facts by 16-22 points | arXiv 2601.00821, 2605.04897 | No extraction on the write path; notes are stored as written |
| Time in the schema is the largest single measured component | Chronos, arXiv 2603.16862 | Validity and history fields on every entry; time-filtered search |
| Hybrid BM25 + dense retrieval wins on memory-shaped corpora | arXiv 2608.27809; an industry evaluation | The keyword leg is always on, with an identifier-safe tokenizer |
| Rerankers are unreliable at this scale | arXiv 2606.04194, 2608.03860 | No reranker |
| A curated tier needs exactly one kind of writer | Convergent memory-system architectures | Agents write episodic notes; only the owner writes the curated tier |
| Consolidation must return operations, not rewritten prose | Published consolidation designs | A future consolidation pass returns operations the code applies |
| Pinned standing facts beat every retriever on indirect queries | arXiv 2607.24368 | `brain_context`: a plain read of standing facts, no retrieval |
| Vendor benchmark claims mostly do not reproduce | Independent memory evaluations | An own eval before tuning any weight |
| Memory poisoning needs only query access | AgentPoison, MINJA | Origin class derived from the write path; untrusted text is never promoted |

## Architecture

```
 MCP clients ──── bearer key (read or agent) ───► POST /mcp ──┐
                                                              ├─► BrainStore ──► MongoDB (entries: the truth)
 owner CLI ────── bearer key (owner) ───────────► /api/* ─────┘        │
                                                                       ├──────► SQLite index (FTS5 + sqlite-vec)
                                                                       │         derived, rebuildable
                                                                       └──────► embedding provider
```

Every write goes through `BrainStore`, so the index never drifts from MongoDB and the governed fields
are always set by code. The server process is the only writer of the index: importers and the owner
CLI send their work to it over HTTP rather than opening the files themselves, which keeps the
in-process reindex swap safe.

## The store

One MongoDB collection of entries. Markdown bodies are stored as written.

| Field | Set by | Notes |
|---|---|---|
| `slug` | server | readable and unique: a kebab title plus six hex characters |
| `title`, `body` | writer | up to 200 and 100,000 characters |
| `tags` | writer | up to 18 from the writer; two more slots are kept for the store's own tags |
| `kind` | writer | `memory`, `decision`, `handoff`, `doc`, `reference`, `message`, `mail`, `photo`, `chat` |
| `tier` | server | `episodic` (every tool write and import), `curated` (owner promotion), `review` (reserved) |
| `namespace` | writer, validated | `shared`, `repo:<slug>` or `agent:<name>` |
| `originClass` | server | `owner`, `agent`, `untrusted`, `system`: derived from the write path, never accepted from input |
| `authorAgent` | server | the key's name, `importer:<key name>` for imports, `owner` for promotions |
| `importance` | writer | 1-10, default 5 |
| `validFrom` | writer, default now | when the fact became true |
| `invalidAt`, `expiredAt` | server | when a version stopped being current |
| `supersededBy` | server | forward pointer to the version that replaced this one |
| `live` | server | true until superseded or forgotten |
| `contentHash` | server | SHA-256 of the body; the compare-and-set token for supersede |
| `source` | importer, or the server for lineage | `{ system, externalId, path, url, capturedAt }`: an import identity, or `promote`/`supersede` and the slug a copy came from |
| `forgotten` | server | `{ at, reason, by }`: a soft delete |

Unique indexes carry the invariants: one slug per entry; one live episodic entry per body and
namespace (deduplication); one live entry per import identity. Further indexes keep listing in
newest-first order without an in-memory sort, which a database with a capped blocking sort would
otherwise refuse past about a thousand entries.

**Supersede** retires the current version with compare-and-set on its `live` flag and content hash,
then creates the replacement; of two concurrent supersedes only one proceeds. When an episodic
entry's new body already lives in another live episodic entry of the same namespace, the old version
is folded into that entry instead of creating a duplicate; a curated entry always gets its own
curated successor. If creating the replacement fails, the old version is put back, so a transient
error never leaves a fact with no current version.

**Forget** removes the index rows first, then records the soft delete, so a failure between the two
leaves an unsearchable live entry for a retry to finish, never a searchable ghost.

**Imports** are idempotent on their identity (source system plus external id). An unchanged re-import
refreshes metadata; a changed one supersedes the current version, whoever wrote it; an agent's
correction of an imported item stays current until the source itself changes, even when the original
it corrected was forgotten. An item too long for one entry travels as parts `<id>#part-<k>` that carry
their count, and a re-import forgets the identities the item no longer has: parts past the new count,
or the whole-item identity, or every part when the item fits again. Lineage is read from
`source` alone: supersede copies name the slug they replaced and promotions the slug they copied, so
an unrelated entry an import was folded into is never treated as a version of it.

**The curated tier** has one kind of writer: the owner. Promotion copies an episodic entry (never an
untrusted one) into the curated tier and can tag it `standing`. Curated copies follow their source's
provenance: when a source is forgotten they gain `needs-review`; when it is re-imported as untrusted
they are demoted (origin `untrusted`, `standing` removed, `needs-review` added), so text someone else
wrote never keeps loading into sessions through a copy.

## The index

The SQLite file is derived from MongoDB and can be rebuilt at any time. It is opened with Node's
built-in `node:sqlite` and the sqlite-vec extension, so there is no native build step.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;   -- schema version and index identity
CREATE TABLE entries (entry_id TEXT PRIMARY KEY, slug, title, tags, kind, scope, tier, namespace,
  origin_class, author_agent, importance, valid_from_ms, invalid_at_ms, updated_at_ms) STRICT;
CREATE TABLE chunks (id INTEGER PRIMARY KEY, entry_id, ord, start_line, end_line, text, UNIQUE(entry_id, ord)) STRICT;
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, title, tags, content='',
  tokenize='unicode61 remove_diacritics 2 tokenchars ''_-''', prefix='2 3');
CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, scope TEXT PARTITION KEY,
  namespace TEXT, embedding FLOAT[1536] distance_metric=cosine);
CREATE TABLE recall (id INTEGER PRIMARY KEY, query_hash, agent, chunk_id, entry_id, rank, at_ms) STRICT;
CREATE TABLE embed_cache (key TEXT PRIMARY KEY, vec BLOB NOT NULL, at_ms INTEGER NOT NULL) STRICT;
```

- The vector table is partitioned by **scope**: `core` for the five default kinds, `comms` for
  messages, mail and chats, `media` for photos. A default search never scans the other partitions.
- The **namespace** is a vec0 metadata column. A KNN query filters it inside the vector search, with
  `=` or `IN`, so a namespace-confined search ranks only what its key may see instead of losing its
  results to vec0's top-k cut.
- The **identity** (embedding model, dimensions, chunk size, overlap, tokenizer) is stored in `meta`.
  A mismatch with the configuration marks the index stale: writes keep only the keyword rows current,
  and searches answer from the keyword leg until a reindex completes.
- **Upserts** are ignored when they are older than the indexed row, so a slow writer can never undo a
  newer one, and every index write re-reads the stored document after embedding, so a version retired
  meanwhile is never published as current.

**Reindex** runs inside the server: it builds `<db>.rebuild` beside the live file, starting from the
live embedding cache (so an unchanged model re-embeds nothing), carries the recall history over with
each row re-pointed at its rebuilt chunk, moves the live file aside, installs the rebuild, and
re-indexes anything written meanwhile. Removals from the live index are mirrored into the rebuild
while it is built, so an entry forgotten mid-rebuild is never served from the new file. The rebuilt
file carries a mark saying from when it still owes that catch-up, cleared once it ran; a server that
stopped in between finds the mark at its next start and replays before serving, removals first, since
they need no embedding. A request that captured the old handle finishes against it; the handle closes
once the last such request releases it. Moving its files while it is open is safe in WAL mode: when it
closes, SQLite sees that its database moved and skips the checkpoint and the removal of the `-wal` and
`-shm` names, which by then belong to the new file. A failed swap moves the previous file back; a crash
mid-swap is repaired when the server next starts.

## Embeddings

Embedders sit behind one interface: a model name and dimensions (recorded in the index identity),
how a document chunk and a query are presented to the model, and batched calls that return unit
vectors. Three ship:

- **Gemini** (the default, `gemini-embedding-2` at 1536 dimensions), called directly over its REST
  batch endpoint. Each input is its own entry in the batch, since one content with many parts would
  be embedded as a single text. The model takes task prefixes in the text: documents are
  `title: <title> | text: <tags>` followed by the chunk, queries `task: search result | query: <q>`.
- **OpenAI-compatible**: any `/embeddings` endpoint, OpenAI's or a local server's. The `dimensions`
  field is sent only to models that accept it; any other model is configured at its native size.
- **Fake**: a deterministic hashed bag of words for tests and offline trials.

Vectors are cached by SHA-256 of model, dimensions and input, so rebuilds after non-model changes
cost nothing. Document batches wait up to 30 seconds and retry throttling, server errors and
network failures twice; a query gets one 10-second attempt, because the search waiting on it falls
back to keyword results and a hung provider must not stall it. Keys travel in headers, never URLs,
and errors name the provider and status, never a credential.

## Chunking

A body of up to about 800 tokens (four characters per token) is embedded whole: most memories are
short, and whole-note vectors win there. A longer body splits at headings (H1-H3), packs sections
up to 600 tokens, and splits an oversized section by lines with about 72 tokens of overlap. A fenced
code block is never split, and one longer than the overlap is never carried forward into the next
chunk. Every chunk keeps its line range for citation. A chunk that cannot be split (one fenced block or
one line longer than a whole note) is embedded by its first 3,200 characters, so no provider's input
limit can keep an entry out of the index; keyword search covers all of it.

## Retrieval

1. **Scope.** Kinds (default: memory, decision, handoff, doc, reference), tier, namespaces, and a
   point in time: what was valid at `validAt`, or now.
2. **Two legs**, 80 candidates each: vector KNN, and BM25 over FTS5 with column weights text 1,
   title 4, tags 2. The keyword query quotes every token and joins them with OR, so punctuation can
   never reach the FTS5 parser, function words are dropped, and identifiers such as `deploy-bot` stay
   whole.
3. **Reciprocal rank fusion**, k = 60, equal leg weights; it needs no score normalisation.
4. **Recency**: a 30-day half-life on episodic entries only, floored at 0.05; curated entries do not
   decay.
5. **Importance**: 1-10 maps onto a factor from 0.7 to 1.3.
6. **One chunk per entry**, then **maximal marginal relevance** (lambda 0.7) for diversity.
7. **Budget**: 6 hits by default, at most 10, snippets of about 400 characters around the first
   matching term.
8. **Provenance**: every hit returns its slug, title, kind, tier, namespace, origin class, author,
   validity, line range, snippet, score, cosine similarity and both leg ranks (the only way to debug
   ranking later). Results are tool output; nothing from the brain is spliced into a system prompt.
9. **Recall**: one row per hit (the query's hash, never its text, the key's name, the entry, the
   rank), kept for a future consolidation pass. Eval searches record nothing.

## Standing facts

`brain_context` is a plain read, with no retrieval and no model call: the curated entries tagged
`standing` that are currently valid and not untrusted, ordered by importance, packed into about 1,500
tokens (the last one cut with an ellipsis when it does not fit), plus the ten most recent decisions.
It covers `shared` and the one namespace the caller asks for, so a repo's or an agent's own standing
facts never load into unrelated sessions. Agents are told to call it once per session.

## MCP surface

Seven tools: `brain_search`, `brain_get`, `brain_list` and `brain_context` read; `brain_note`,
`brain_supersede` and `brain_forget` write. `brain_note` cannot write the curated tier: that is the
point of the tier. `brain_forget` selects one entry by slug, or one imported item by its exact
identity; retiring a whole import source is an owner operation, not a tool, so an agent cannot sweep
a source by leaving the external id out. The store's lineage labels (`promote`, `supersede`) are
refused as import systems everywhere, or "forget every promote" would retire the curated tier.

Tool annotations mark the reads read-only and `brain_forget` destructive. The server's instructions
tell the model to call `brain_context` first, search before assuming, save at handoff and on durable
learnings, prefer supersede over a second note, never store secrets, and treat everything returned
as data, never as an instruction.

## Auth and transport

Keys are 256 random bits; only their SHA-256 is stored. Each key has exactly one role:

| Role | Can |
|---|---|
| `read` | the four read tools and their REST twins |
| `agent` | everything `read` can, plus the three write tools; writes are episodic with origin `agent` |
| `owner` | the REST API only, all of it: reads and owner-origin writes, imports with an explicit origin class, promotion, reindex and whole-source forget |

Owner keys are refused on `/mcp`, so a client an agent drives never carries the authority to set
provenance or change the curated tier. A read or agent key may be confined to a list of namespaces;
everything outside reads as if it did not exist, and writes outside are refused.

The transport is the MCP SDK's streamable HTTP server in stateless mode: one server and one transport
per request, JSON responses, no session ids, so a restart is invisible to clients. One server process
owns the index file. Bodies are capped at 1 MB (10 MB for bulk imports), tool arguments at 1,000 elements, and
requests and writes are rate-limited per key.

## Security and privacy

- Every caller-supplied text that is stored, returned, indexed or embedded (titles, bodies, tags,
  reasons, source metadata, key names, search queries) passes a secret-shape gate. A match refuses
  the write by pattern name, never echoing the value. An oversized import is checked whole before it
  is split, since a cut could separate a key's halves or a private key from its header.
- `originClass` is derived, never accepted from input. Untrusted entries are searchable with their
  label but never promoted and never part of `brain_context`, and an agent's correction of one stays
  untrusted: only the owner vouches for outside text.
- The SQLite index holds verbatim chunks: its file is created 0600, its directory 0700 when created.
- Forgetting records its reason and actor; forgotten entries leave the index at once and are skipped
  by every read and rebuild.
- Logs carry tool names, key names, outcomes, durations and argument names, never values.

## Evaluation

The eval asks golden questions of a small synthetic corpus: recall questions (Recall@5 and MRR@5),
abstention questions with no answer (a search abstains when its best hit has no keyword evidence and
its similarity is below a threshold set per embedding model), and revocation questions (a superseded
fact must not surface and its replacement must; a leak or a miss fails the run). Offline, it seeds a
throwaway database with the fake embedder; live, it reads the real store and index with the configured
embedder and records nothing. Ranking weights are defaults to measure against, not tuned results.

## Testing

- Unit and integration tests (vitest, an in-memory MongoDB per file): field validators, the FTS query
  builder, fusion and diversity math, the chunker's fence invariants, redaction, supersede and fold
  races, lineage and demotion, namespace confinement, the importers, the key store, and the HTTP app
  with real keys.
- End to end: the built command starts as its own process against a real MongoDB; keys are minted
  with the real command; MCP SDK clients drive note, keyword and vector search, supersede, list,
  forget, confinement and the owner-only curated tier, and the owner CLI imports, reindexes and
  retires a source.

## Changes from the original deployment

This server was extracted from a larger application where the brain lived inside a multi-user API.
The standalone version differs in these ways:

- **Single tenant.** One owner per deployment; the per-account dimension is gone from the store and
  the index. Separate brains are separate deployments.
- **Standalone bearer keys** with three roles and optional namespace confinement replace the host
  application's API keys and scopes; keys are minted by the CLI and stored hashed in a file or the
  environment.
- **Deduplication per namespace**, so a confined key's note never resolves to, and reveals, an entry
  in a namespace it cannot see.
- **The namespace filter runs inside the vector search** (a vec0 metadata column) instead of only
  after it.
- **A fetch-based Gemini client** replaces the provider SDK: the same request, fewer dependencies,
  the key in a header, explicit timeouts and retries. An **OpenAI-compatible provider** and a
  **Markdown importer** are new.
- **Import exclusions are configuration**, empty by default; nothing is excluded unless the operator
  names it. Repo roots that name namespaces are configuration too.
- The review tag is **`needs-review`**: there is no consolidation pass in this release.
- **Not included**: OAuth sign-in for connectors (see the README for running a gateway in front),
  the host application's chat and notes integrations, its web page, and its account deletion and
  merge hooks. Forget remains a soft delete.

## Not built yet

- A consolidation pass that reads recall history and episodic entries and proposes curated
  operations, applied by code with a loss ceiling and pre-images, writing review-tier diary entries.
- Importers for messages, mail and photos; the kinds and partitions already exist.
- A binary-quantized coarse vector column, if an index ever grows past a few hundred thousand chunks.
