# Buzz CLI fixtures — captured, not invented

These three payloads were captured from the **installed `buzz` CLI** authenticated against the
live relay (`https://isaac-macmini.tailb41ff5.ts.net:3000`) on 2026-08-14, by running the exact
argv the adapter uses:

| file | command |
|---|---|
| `channels-list.json` | `buzz channels list` |
| `channels-get.json` | `buzz channels get --channel <uuid>` |
| `messages-get.json` | `buzz messages get --channel <uuid> --limit 2` |

`messages-get.json` has its `content` fields replaced — the captured bodies are the owner's
messages. Every other field is exactly as the relay returned it, because the field *names* are
what the adapter reads and what these fixtures exist to pin. `channels-list.json` and
`channels-get.json` are unmodified.

**Why capture rather than write by hand.** #423 was a pair of invented assumptions: a `--json`
flag the CLI rejects, and an `id` field the payload does not carry. Both survived because the
tests replaced the transport with a double that agreed with them. A fixture written from the
same imagination as the adapter proves nothing; one taken from the CLI is a second source.

**Re-capture** after a `buzz` upgrade — the version these were taken from is recorded in
`cli-version.txt`. If the shape has changed, `tests/unit/buzz-cli-surface.test.ts` is what
should fail.
