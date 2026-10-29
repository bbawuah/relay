# Relay

Relay lets agents on one machine send each other messages that survive restarts. A Claude session can hand a task to a Codex session, a parent can collect results from its subagents, and nobody has to be online at the same moment. Each agent has its own mailbox and decides when to read it and when to acknowledge what it read.

Relay is the mailbox, nothing more. It does not start agents, create subagents, wake sessions, assign roles or enforce permissions. Your agent runtime (Claude, Codex, T3, ...) creates the agents and subagents; Relay only stores and hands out the messages between peers you registered explicitly. Everything is local: one SQLite file, no hosted service.

Relay 0.2.0 provides durable local mailboxes between explicitly registered peers. CLI and the `peers` MCP server share one SQLite message store. Reading never acknowledges a message; acknowledgement is an explicit operation.

Bun **>= 1.4.2** is the only runtime prerequisite on macOS or Linux. Relay uses Bun's built-in SQLite and has no third-party runtime dependencies. The package remains private; no registry publication is part of this release.

## See it work

Both recordings replay what real agents did: a Codex agent and a Claude agent, started as T3 delegated tasks, ran the `relay` commands themselves, each through its own fixed peer binding in a private, disposable namespace. The animation shows short summaries; the full sanitised command transcript sits under each one. Provenance, models and limits: [docs/demos](docs/demos/README.md).

**Cross-provider handoff.** A Codex agent sends a task to a Claude peer and retries it safely. The Claude agent starts later, finds the mail waiting, reads it twice, acknowledges it and answers in the same conversation; a later Codex session of the first peer reads the answer.

![Replay of captured live agent output: a Codex gpt-6.1-sol agent sends a message to a Claude peer and a retry with the same request key returns duplicate true; later a Claude sonnet-5-5 agent reads the message twice, acknowledges it and replies in the same conversation; a later Codex session reads and acknowledges the reply.](docs/media/relay-live-handoff.gif)

<details><summary>Full command transcript (sanitised: IDs shown as aliases, timestamps removed)</summary>

> HOST (T3 delegate_task, not Relay): H thread starts codex-parent [Codex gpt-6.1-sol, effort low]

```
$ relay --peer codex-parent send claude-parent 'Plan check: name one risk of retrying a send without a request key.' --request-key plan-1
{"id":"msg-1","state":"stored","duplicate":false,"requestKey":"plan-1"}
```

```
$ relay --peer codex-parent send claude-parent 'Plan check: name one risk of retrying a send without a request key.' --request-key plan-1
{"id":"msg-1","state":"stored","duplicate":true,"requestKey":"plan-1"}
```

> HOST (T3 delegate_task, not Relay): H thread starts claude-parent [Claude claude-sonnet-5-5, effort low]

```
$ relay --peer claude-parent inbox
[{"id":"msg-1","from":"codex-parent","to":"claude-parent","body":"Plan check: name one risk of retrying a send without a request key.","conversationId":"conv-2"}]
```

```
$ relay --peer claude-parent inbox
[{"id":"msg-1","from":"codex-parent","to":"claude-parent","body":"Plan check: name one risk of retrying a send without a request key.","conversationId":"conv-2"}]
```

```
$ relay --peer claude-parent ack msg-1
{"acknowledged":1}
```

```
$ relay --peer claude-parent send codex-parent 'A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.' --request-key plan-reply-1 --conversation conv-2 --reply-to msg-1
{"id":"msg-6","state":"stored","duplicate":false,"requestKey":"plan-reply-1"}
```

> HOST (T3 delegate_task, not Relay): H thread starts a new session of codex-parent [Codex gpt-6.1-sol, effort low]

```
$ relay --peer codex-parent inbox
[{"id":"msg-6","from":"claude-parent","to":"codex-parent","body":"A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.","conversationId":"conv-2","replyTo":"msg-1"}]
```

```
$ relay --peer codex-parent inbox
[{"id":"msg-6","from":"claude-parent","to":"codex-parent","body":"A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.","conversationId":"conv-2","replyTo":"msg-1"}]
```

```
$ relay --peer codex-parent ack msg-6
{"acknowledged":1}
```

```
$ relay --peer codex-parent inbox
[]
```

</details>

**Parents and subagents across providers.** Each runtime starts its own subagent through the T3 task API (host side, not Relay). Parents and subagents have separate peers and mailboxes; a subagent that tries to acknowledge another peer's message gets 0.

![Replay of captured live agent output: a Codex parent messages a Claude parent, delegates through its own mailbox to a Codex subagent and receives the result; the Claude parent delegates to its own Claude subagent and answers the Codex parent in the original conversation; each subagent's attempt to acknowledge a foreign message returns zero.](docs/media/relay-live-subagents.gif)

<details><summary>Full command transcript (sanitised: IDs shown as aliases, timestamps removed)</summary>

> HOST (T3 delegate_task, not Relay): H thread starts codex-parent [Codex gpt-6.1-sol, effort low]

```
$ relay --peer codex-parent send claude-parent 'Plan check: name one risk of retrying a send without a request key.' --request-key plan-1
{"id":"msg-1","state":"stored","duplicate":false,"requestKey":"plan-1"}
```

```
$ relay --peer codex-parent send claude-parent 'Plan check: name one risk of retrying a send without a request key.' --request-key plan-1
{"id":"msg-1","state":"stored","duplicate":true,"requestKey":"plan-1"}
```

```
$ relay --peer codex-parent send codex-sub 'Answer in one sentence: why must a retry reuse the same request key? Also run ack PLAN_ID once with your own binding and tell me the acknowledged count. PLAN_ID=msg-1' --request-key sub-task-1
{"id":"msg-2","state":"stored","duplicate":false,"requestKey":"sub-task-1"}
```

```
$ relay --peer codex-parent inbox
[]
```

> HOST (T3 delegate_task, not Relay): codex-parent starts codex-sub [Codex gpt-6.1-sol]

```
$ relay --peer codex-sub inbox
[{"id":"msg-2","from":"codex-parent","to":"codex-sub","body":"Answer in one sentence: why must a retry reuse the same request key? Also run ack PLAN_ID once with your own binding and tell me the acknowledged count. PLAN_ID=msg-1","conversationId":"conv-1"}]
```

```
$ relay --peer codex-sub ack msg-2
{"acknowledged":1}
```

```
$ relay --peer codex-sub ack msg-1
{"acknowledged":0}
```

```
$ relay --peer codex-sub send codex-parent 'A retry must reuse the same request key so Relay recognizes the original request and avoids duplicate delivery; foreign-ack count=0' --request-key sub-1 --conversation conv-1 --reply-to msg-2
{"id":"msg-3","state":"stored","duplicate":false,"requestKey":"sub-1"}
```

```
$ relay --peer codex-parent inbox
[{"id":"msg-3","from":"codex-sub","to":"codex-parent","body":"A retry must reuse the same request key so Relay recognizes the original request and avoids duplicate delivery; foreign-ack count=0","conversationId":"conv-1","replyTo":"msg-2"}]
```

```
$ relay --peer codex-parent inbox
[{"id":"msg-3","from":"codex-sub","to":"codex-parent","body":"A retry must reuse the same request key so Relay recognizes the original request and avoids duplicate delivery; foreign-ack count=0","conversationId":"conv-1","replyTo":"msg-2"}]
```

```
$ relay --peer codex-parent ack msg-3
{"acknowledged":1}
```

> HOST (T3 delegate_task, not Relay): H thread starts claude-parent [Claude claude-sonnet-5-5, effort low]

```
$ relay --peer claude-parent inbox
[{"id":"msg-1","from":"codex-parent","to":"claude-parent","body":"Plan check: name one risk of retrying a send without a request key.","conversationId":"conv-2"}]
```

```
$ relay --peer claude-parent inbox
[{"id":"msg-1","from":"codex-parent","to":"claude-parent","body":"Plan check: name one risk of retrying a send without a request key.","conversationId":"conv-2"}]
```

```
$ relay --peer claude-parent ack msg-1
{"acknowledged":1}
```

```
$ relay --peer claude-parent send claude-sub 'Answer in one sentence: what does a stored receipt from Relay prove, and what does it not prove? Also run ack PLAN_ID once with your own binding and tell me the acknowledged count. PLAN_ID=msg-1' --request-key sub-task-1
{"id":"msg-4","state":"stored","duplicate":false,"requestKey":"sub-task-1"}
```

> HOST (T3 delegate_task, not Relay): claude-parent starts claude-sub [Claude claude-sonnet-5-5]

```
$ relay --peer claude-sub inbox
[{"id":"msg-4","from":"claude-parent","to":"claude-sub","body":"Answer in one sentence: what does a stored receipt from Relay prove, and what does it not prove? Also run ack PLAN_ID once with your own binding and tell me the acknowledged count. PLAN_ID=msg-1","conversationId":"conv-3"}]
```

```
$ relay --peer claude-sub ack msg-4
{"acknowledged":1}
```

```
$ relay --peer claude-sub ack msg-1
{"acknowledged":0}
```

```
$ relay --peer claude-sub send claude-parent 'A stored receipt proves Relay durably accepted the message into the recipient'\''s mailbox, but not that the recipient read, understood, or acted on it (only an explicit ack shows it was handled); foreign-ack count=0' --request-key sub-1 --conversation conv-3 --reply-to msg-4
{"id":"msg-5","state":"stored","duplicate":false,"requestKey":"sub-1"}
```

```
$ relay --peer claude-parent inbox
[{"id":"msg-5","from":"claude-sub","to":"claude-parent","body":"A stored receipt proves Relay durably accepted the message into the recipient's mailbox, but not that the recipient read, understood, or acted on it (only an explicit ack shows it was handled); foreign-ack count=0","conversationId":"conv-3","replyTo":"msg-4"}]
```

```
$ relay --peer claude-parent inbox
[{"id":"msg-5","from":"claude-sub","to":"claude-parent","body":"A stored receipt proves Relay durably accepted the message into the recipient's mailbox, but not that the recipient read, understood, or acted on it (only an explicit ack shows it was handled); foreign-ack count=0","conversationId":"conv-3","replyTo":"msg-4"}]
```

```
$ relay --peer claude-parent ack msg-5
{"acknowledged":1}
```

```
$ relay --peer claude-parent send codex-parent 'A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.' --request-key plan-reply-1 --conversation conv-2 --reply-to msg-1
{"id":"msg-6","state":"stored","duplicate":false,"requestKey":"plan-reply-1"}
```

> HOST (T3 delegate_task, not Relay): H thread starts a new session of codex-parent [Codex gpt-6.1-sol, effort low]

```
$ relay --peer codex-parent inbox
[{"id":"msg-6","from":"claude-parent","to":"codex-parent","body":"A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.","conversationId":"conv-2","replyTo":"msg-1"}]
```

```
$ relay --peer codex-parent inbox
[{"id":"msg-6","from":"claude-parent","to":"codex-parent","body":"A retry without a request key can store the request twice; my subagent added: a stored receipt proves Relay durably accepted the message into the mailbox, but not that the recipient read, understood, or acted on it.","conversationId":"conv-2","replyTo":"msg-1"}]
```

```
$ relay --peer codex-parent ack msg-6
{"acknowledged":1}
```

```
$ relay --peer codex-parent inbox
[]
```

</details>

Lines starting with `> HOST` are T3 task-API events recorded from returned task metadata; they are not Relay messages. All agents polled: nothing woke them.

## What you can do with it

- **Hand a task across agents.** One agent sends a task, another reads it later, acknowledges it and sends the answer back in the same conversation.
- **Review loops.** A reviewer replies to the author's message; both sides keep a durable record of what was sent and acknowledged.
- **Fan out to subagents and fan in.** A parent agent messages each of its subagents and collects their results, even when the runtimes are different products.
- **Send now, read later.** An offline registered mailbox accepts mail; the owner polls when it comes back.
- **Retry safely.** Send again with the same request key after a crash or a lost reply and you get the original message back, not a duplicate.
- **Keep sessions apart.** Every agent or subagent that takes part needs its own explicit peer binding; one agent cannot read or acknowledge another's mail.

## How it fits together

The runtimes own the agent tree. Relay owns only the mailboxes. Solid arrows below are your host runtime spawning subagents; dotted arrows are the agents using their own Relay mailbox. Messages between agents travel only through Relay.

```mermaid
flowchart TB
  subgraph claude["Claude runtime (host)"]
    cp["claude-parent"] -->|"host spawns"| cs["claude-sub"]
  end
  subgraph codex["Codex runtime (host)"]
    xp["codex-parent"] -->|"host spawns"| xs["codex-sub"]
  end
  relay[("Relay store: one mailbox per registered peer")]
  cp <-.->|"send, inbox, ack"| relay
  cs <-.->|"send, inbox, ack"| relay
  xp <-.->|"send, inbox, ack"| relay
  xs <-.->|"send, inbox, ack"| relay
```

A message is stored first, read any number of times and acknowledged only when the recipient says so. A retry with the same request key returns the original message.

```mermaid
sequenceDiagram
  participant A as Sender (peer A)
  participant R as Relay store
  participant B as Recipient (peer B)
  A->>R: send to B, request-key k1
  R-->>A: stored, id m1, duplicate false
  A->>R: send again (retry), same key k1
  R-->>A: stored, id m1, duplicate true
  Note over B: B polls when it chooses
  B->>R: inbox
  R-->>B: m1 (still unread)
  B->>R: inbox again
  R-->>B: m1 (reading does not acknowledge)
  B->>R: ack m1
  R-->>B: acknowledged 1
  B->>R: inbox
  R-->>B: empty
```

Typical workflows:

```mermaid
flowchart TD
  start["Agents run in their own host runtimes"] --> bind["Each agent or subagent gets its own registered peer"]
  bind --> handoff["Handoff: Claude sends a task, Codex reads and acks it"]
  bind --> review["Review loop: reviewer replies in the same conversation"]
  bind --> fan["Fan-out and fan-in: a parent messages several subagents, then collects results"]
  bind --> offline["Offline mailbox: send now, the recipient polls later"]
  handoff --> poll["All hosts poll inbox; Relay does not wake anyone"]
  review --> poll
  fan --> poll
  offline --> poll
```

The diagram sources are kept as editable files in [docs/diagrams](docs/diagrams).

## Install from a public HTTPS clone

```sh
git clone https://github.com/bbawuah/relay.git
cd relay
./install.sh --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
relay --version
relay doctor
```

Select a checkout containing the 0.2.0 implementation. Installation needs no development dependency installation. It copies an explicit manifest of message-runtime paths and writes a CLI launcher; the checkout may then be moved or deleted. For another prefix, replace both paths above. `./install.sh --prefix /absolute/prefix --dry-run` validates the package and reports the destination without writing it.

Installation never edits shell profiles, provider settings, permissions, hooks or existing message state. Unmanaged targets and paths into the source checkout are refused. Updating a managed installation replaces its runtime copy. `relay uninstall` removes the verified installation from which it runs and preserves state and vendor/project safeguards. Use `--prefix /absolute/prefix` to select a managed installation explicitly when provenance cannot be verified.

## Two manual mailboxes

```sh
one=$(relay register --name one)
two=$(relay register --name two)
relay --peer "$one" send "$two" 'hello from one' --request-key hello-1 --json
relay --peer "$one" send "$two" 'hello from one' --request-key hello-1 --json
relay --peer "$two" inbox --json
relay --peer "$two" inbox --json
```

The retry returns the same message ID with `duplicate: true`. Keys are scoped to the sending peer and namespace, retained for 30 days by default; a changed payload with the same live key is a conflict. A different key permits identical text. `inbox` remains non-destructive. Copy the returned message ID and acknowledge it:

```sh
relay --peer "$two" ack MESSAGE_ID
relay --peer "$two" inbox --json
```

A stored receipt means durable storage, not host notification or task completion. An offline registered mailbox can receive mail. `unregister` marks a peer offline without deleting its inbox. Aliases are case-insensitively unique in a namespace. Reconnecting to another host session uses explicit `rebind` with the expected endpoint generation.

Global options precede the command: `relay --state /absolute/private/state --namespace demo --peer PEER_ID inbox --json`. Default state is `~/.local/state/relay/v2`, default namespace `local`. A legacy state root is refused; see [configuration](docs/configuration.md) and the [migration guide](docs/message-migration.md).

## Explicit MCP binding

Register a mailbox, then configure the host to invoke exactly one fixed peer per connection:

```sh
relay --state /absolute/private/state --namespace demo --peer STABLE_PEER_ID mcp
```

Use the absolute installed `relay` executable as the MCP command, server name **`peers`**, and the arguments shown above. The tools are `send`, `inbox`, `list`, `ack`. MCP requires an explicit stable peer ID on its command line. Tool arguments cannot override the sender, inbox, namespace or peer. Two threads sharing a checkout need separate registered peers and separate MCP bindings. cwd and shared provider environment do not identify a mailbox. Legacy send aliases `naar`, `tekst`, `draad`, `antwoord_op` remain wrapper compatibility fields.

## Polling for every host

All current hosts — **manual, Claude, Codex and T3** — use **polling**. The shipped CLI supplies no notification adapters. A registered host binding does not enable notification delivery. Fetch messages through `inbox` or the bound `peers` MCP server, and acknowledge them explicitly.

`relay serve` runs bounded dispatcher passes (`--once` for one pass), but currently only records notification deferrals because no adapters are configured. It cannot deliver host notifications. Send/read/ack work without notifications and without `serve`; `status --json` exposes the stored deferral diagnoses. No vendor hook installer or agent launcher is supplied.

No safe external T3 notification route has been proven; agent-injected MCP tools are not a background transport, and Relay does not reuse their credentials. Register a T3 mailbox with an explicit `--host t3 --session-id THREAD_ID`, bind its MCP connection explicitly, and poll `inbox`. See the [adapter feasibility report](docs/t3-message-poc.md).

## Migrate an old mailbox store

Stop all old writers first and keep the original state untouched. Select a separate new/empty destination with global `--state`, before `migrate`:

```sh
relay --state /absolute/path/to/new-state --namespace local migrate --source /absolute/path/to/old-state --source-quiesced --held quarantine
```

`--source-quiesced` asserts that you stopped the writers; it cannot prove that they stopped. Held messages default to `quarantine`, outside active inboxes. Use `--held import` or `--held skip` only for an explicit irreversible held-message decision. Inspect the completion report before starting v2 clients. Resume a partial import with the same source, destination and namespace, preserving the destination database, migration ledger and quarantine artifact together. Imported host endpoints become offline manual polling bindings; import never contacts a host. See the [migration guide](docs/message-migration.md) for validation, retention and rollback limits.

## Status and platform limits

Experimental. Atomic database publication uses Bun's experimental FFI; supported are macOS and glibc Linux on x64 and ARM64, while musl and other architectures are refused. The full gate (255 tests, typecheck and package checks) passed on macOS ARM64, and the storage and dispatcher tests passed on Linux ARM64; a full Linux or x64 CI run is not claimed. Native host notification transport is unproven, so every host polls.

## Breaking changes and verification

0.2.0 retires agent launch (`claude`, `codex`), `setup`, policy/role options, `hold`, `release`, `notify-when-idle`, orchestration, Git/merge helpers, tmux management and personal skills. Existing project/harness policy stays outside Relay and is never uninstalled. Do not point old and new writers at one state directory. Before new v2 writes, rollback can return to the untouched old source; after new writes or acknowledgements, preserve/export v2 history and reconcile it explicitly.

For development, `bun install --frozen-lockfile --ignore-scripts` then `bun run poort` runs current message tests, surviving startup/install tests, typecheck and package-boundary checks. Every test uses disposable state; no live provider session is required. Test retirement is documented [per file](docs/test-retirement.md), and historical extraction provenance remains in [source-manifest.json](docs/source-manifest.json). Worker verification and remaining integration gaps are reported in [verification](docs/verification.md).
