# Security policy

Please report vulnerabilities privately with GitHub's **Report a vulnerability** button (Security →
Advisories) on this repository, not in a public issue. You will get an answer within a few days.

## What the server defends

badland-brain holds what your agents remember, so it guards three things:

- **Who can read and write.** Every request needs a bearer key with one role (`read`, `agent` or
  `owner`), optionally confined to a list of namespaces. Only SHA-256 hashes of keys are stored, and
  a keys file that cannot be parsed fails closed. Owner keys never work on the MCP endpoint.
- **What gets in.** Titles, bodies, tags, reasons, source metadata, key names and search queries are
  refused when they contain a secret shape (private keys, API keys and tokens of common services,
  JWTs, bearer tokens, brain keys); the refusal names the pattern, never the value.
- **How far to trust what comes out.** Every entry carries its origin class and author. Only the
  owner writes the curated tier, text imported as untrusted is never promoted, and clients should
  treat everything the brain returns as data, never as instructions.

The server binds to loopback by default and does not terminate TLS: put an HTTPS proxy in front of
it before exposing it. The README's [security model](README.md#security-model) has the details,
including the rate limits, size limits and what is logged.

## In scope

Authentication and role or namespace bypasses, ways to write the curated tier without the owner
key, secret shapes that pass the gate, key material reaching logs, error messages or the index, and
anything that lets a request read entries its key should not see.
