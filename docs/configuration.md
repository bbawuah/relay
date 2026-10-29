# Message configuration (0.2.0)

Global CLI options come before the command. Message bodies are literal data; options after `send` never become global identity overrides.

| Setting | Explicit option | Environment/default |
| --- | --- | --- |
| State directory | `--state /absolute/private/path` | `RELAY_STATE_DIR`, otherwise `~/.local/state/relay/v2` |
| Namespace | `--namespace NAME` | `RELAY_NAMESPACE`, otherwise `local` |
| CLI peer binding | `--peer PEER_ID` | `RELAY_PEER_ID` may provide a CLI default |
| MCP peer binding | `--peer STABLE_PEER_ID` | Must be explicit on the MCP command line; environment is insufficient |

The state directory contains `messages.sqlite` (schema 2) with WAL and FULL synchronous writes. Use private, owned local-disk paths. Do not copy, open or repurpose the old launch-reservation database. A legacy root containing `peers/` or `register/` requires explicit migration to a new directory. Installation and help/version do not create or change message state.

## Addresses, reconnect and acknowledgements

`relay register --name NAME` creates a manual connection and prints its stable peer ID; `--json` prints the peer. `--host t3 --session-id THREAD_ID` records an explicit T3 thread target. Claude/Codex bindings similarly require an explicit host session; registration does not launch or configure a vendor. Peer names are aliases, unique ignoring case within the selected namespace. Namespace plus peer ID addresses a mailbox; directory bindings are routing data, not authorization policy.

`relay --peer ID send TO TEXT --request-key KEY --json` returns a stored receipt. Omit the key to generate and return one. A retry of the same sender/key/payload returns the original message; a conflicting payload is rejected while the receipt is retained (default 30 days). Replies use `--conversation ID --reply-to ID` and require a retained participant/conversation reference (default 30 days). Unread messages are not removed by metadata retention.

`relay --peer ID inbox --json` reads unread envelopes without acknowledging them. `relay --peer ID ack MESSAGE_ID...` explicitly acknowledges them. Foreign, unknown and already acknowledged IDs count zero. Acknowledgement means receipt, not task completion. `unregister ID` marks the endpoint offline and preserves the mailbox.

To bind a new session to the same mailbox, use `relay rebind --peer ID --expected-generation N --host HOST --session-id SESSION_ID`. Registration does not silently replace another session; rebind checks the generation and preserves mailbox identity. An in-flight old host notification cannot be unsent. Message read/ack remains bound to the stable mailbox.

## Host integration

Configure an MCP server named `peers` whose command is the absolute installed Relay executable and whose arguments are `--state /absolute/private/path --namespace NAME --peer STABLE_PEER_ID mcp`. Each connection has one fixed binding. Do not share one bound MCP server among distinct thread inboxes. Tools use English v2 fields; the send wrapper also accepts legacy aliases `naar`, `tekst`, `draad`, `antwoord_op`, rejects conflicting aliases, and rejects identity overrides.

T3 notifications remain unsupported/polling until an authenticated external transport proves stable request IDs across retries and safe behavior with pending user questions. Agent-injected tools are not an external dispatcher API; no borrowed session token, T3 database access or vendor hooks are used. See [T3 proof of concept](t3-message-poc.md).

`relay serve` explicitly starts dispatch; `relay serve --once` performs one bounded pass. Without dispatch, mailbox operations still work and retry jobs remain stored. Presence is host-observed state, not proof that an assignment finished. `relay status --json` and `relay doctor` report unread mail, persisted diagnoses and dispatcher/adapter limitations.

## Installation boundaries and migration

`install.sh` and the installed CLI neutralize Bun config, cwd tsconfig mappings, dotenv, preloads and macros before JavaScript startup. They preserve the caller's cwd without using it as identity. The runtime manifest admits only message modules, the CLI/MCP wrappers, installer/runtime helpers and explicitly named documentation. It rejects symlinked inputs, third-party runtime dependencies and imports into removed/missing code. No broad scripts/agents trees, governance hooks, personal skills, launcher or Git/merge machinery are copied.

Installation never edits `lab-lead-hooks`, provider config, permissions or existing project safeguards. Uninstall preserves them and message state. Existing shared hooks are not automatically migrated or removed. Retired roles, admission policies, `setup`, vendor launch, idle subscriptions and orchestration commands require the [0.2.0 migration guide](message-migration.md), maintained by F. That guide/importer may be pending during stream integration. Keep the old source untouched and do not run legacy and v2 writers against the same state.
