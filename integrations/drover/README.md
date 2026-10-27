# Drover plugin

A [Drover](https://github.com/coletebou/drover) plugin that puts a badland-brain server behind
Drover's ops, MCP tools and search. Agents that already talk to Drover get the brain as
`drover_brain_*` tools, and Drover's search returns brain entries beside its own index.

It is a self-contained MCP client over streamable HTTP: it imports nothing from Drover, so it works
with any Drover that loads plugins, and its tests run in this repository.

## Install

Point Drover at this directory, either by listing it in `DROVER_PLUGINS` (directories separated by
`:`):

```sh
export DROVER_PLUGINS=/path/to/badland-brain/integrations/drover
```

or by linking it into Drover's plugin directory, `~/.config/drover/plugins/`, which Drover scans when
`DROVER_PLUGINS` is unset. Restart the Drover daemon to load it.

## Configure

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_URL` | `http://127.0.0.1:8270` | The server's base URL; the plugin calls `${BRAIN_URL}/mcp` and `${BRAIN_URL}/healthz` |
| `BRAIN_KEY` | none | A `read` or `agent` key (an owner key is refused on `/mcp`) |
| `BRAIN_KEY_FILE` | none | Used when `BRAIN_KEY` is unset: a file holding just the key, or a dotenv file with a `BRAIN_KEY=` line (the last one wins) |

`BRAIN_URL` must be `https://`, or plain `http://` only to a loopback address, since the key travels
with every request; it takes no query or fragment, and a path prefix (a proxy mounting the server
under `/brain`) is fine. The key is read on every call, so a key added or rotated after the daemon
started works without a restart, and a rotated key starts a new MCP session. The plugin never logs,
returns or keeps the key; `brain.status` reports only whether one is configured and where it came
from.

Mint a key for the machine Drover runs on with `badland-brain keys mint --name drover@laptop --role
agent` (or `--role read` for search only).

## Ops

| Op | Mutates | What it does |
|---|---|---|
| `brain.status` | no | The URL, whether a key is configured (never its value), the server's health, and with a key the tools it can call and whether it can write |
| `brain.context` | no | `brain_context`: standing facts and recent decisions, optionally for a namespace |
| `brain.search` | no | `brain_search`: `query` (up to 300 characters), `limit` (1-10), `kinds`, `namespace`, `tier`, `validAt` |
| `brain.get` | no | `brain_get`: one entry by slug, with its `contentHash` |
| `brain.note` | yes | `brain_note`: `title`, `body`, `kind` (`memory`, `decision`, `handoff` or `doc`), `tags`, `namespace`, `importance`, `validFrom` |
| `brain.supersede` | yes | `brain_supersede`: `slug`, `body`, `reason`, `expectedHash`, `title`, `tags` |
| `brain.call` | no | Any tool the server marks read-only, by name, with its own arguments (for example `brain_list`); write tools are refused without being called |

Every op also takes Drover's `host` argument, to run on another machine of the fleet whose
environment has its own `BRAIN_URL` and `BRAIN_KEY`. Bad input is refused before a request goes out;
a tool error comes back as the server's own sentence with its code, and HTTP failures say what to fix
(an unknown key, a refused role, a rate limit, an unreachable or silent server) without the key.

## Search kind `brain`

The plugin serves Drover's remote search kind `brain`: when a Drover search includes it, the plugin
sends the query (cut to 300 characters) to `brain_search`, asks for at most 10 hits, and maps each to
Drover's hit fields (`title`, `snippet`, `ts`, `slug`, `namespace`, `tier`, `author`, `role`,
`score`), plus `origin`, the entry's origin class, so a client can weigh how far to trust it. Drover fuses them with its own index's hits by rank. When Drover stops waiting, the request
to the brain is stopped too; one caller giving up never fails another caller waiting on the same
session start.

## Tests

From the repository root:

```sh
npm test                 # includes integrations/drover/test: a fake MCP server on loopback, no network, no real key
npm run test:e2e         # includes the plugin against the real server process
```
