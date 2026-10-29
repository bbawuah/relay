# Relay message layer plan

Status: implementation authorized by Brian's request to fan out work as lead, 29 October 2026. Original baseline: `3ad65ce16f4552c0423ff85f8b3a1bc14148d072`. This plan changes Relay's scope; it does not change an agent's existing permissions or installed project policy.

Relay will provide local messaging between agent sessions in T3 Code and standalone clients. T3 owns its threads, worktrees, delegation and provider execution. Standalone clients own their own execution. Relay owns addressing, durable mailboxes, acknowledgements, retries and notification adapters.

## Scope

Keep:

- CLI and MCP access to the same message service; preserve MCP server name `peers`.
- Stable peer addresses, human-readable aliases and explicit binding to a host session.
- Message IDs, conversation IDs, reply references, inboxes and explicit acknowledgements.
- Restart recovery, caller-supplied idempotency keys, bounded queues and notification retries.
- Optional unread notifications and presence events, when a host actually exposes them.
- Private local storage, safe startup, safe installation and validation of addresses and envelopes.

Remove from the delivered product:

- Lead/worker permission roles, role environment variables and implicit trust relationships.
- `accept/hold/refuse`, per-sender admission policies and operator-only release commands.
- External-content taint propagation and permission instructions embedded in message formatting.
- Shell/Git guards, provider permission presets, approval rules, personal skills and command runners.
- PR/merge/release helpers, merge queues, tmux management and worktree/agent spawning.
- Conversation-length restrictions such as today's eight-reply hop limit. Replies are ordinary messages; forwarding-loop protection belongs only to an adapter that actually forwards messages.

Message size limits, storage quotas, retry budgets and backpressure remain configurable transport limits. They do not depend on a lead role or judge message content. Messages remain labelled data and retain unambiguous delimiters.

Existing project/harness safeguards stay outside Relay. Removing Relay's policy source does not uninstall or disable those safeguards.

## Target structure

Proposed directories, not existing interfaces:

```text
src/messages/       envelope, send, read, ack, receipts
src/storage/        SQLite schema, transactions, retention, importer
src/directory/      peer addresses, aliases and host-session bindings
src/dispatch/       durable notification outbox and bounded retries
src/adapters/       T3, Claude, Codex, manual polling
src/mcp/            peers server, thin wrapper over message service
src/cli.ts          CLI, thin wrapper over the same service
```

Use a small message-endpoint interface: resolve a session binding, report notification capabilities, and notify that unread messages exist. Do not introduce an `AgentRuntime.spawn/terminate` abstraction. Relay neither starts nor stops T3 agents. Terminal convenience wrappers, if retained during migration, only attach messaging and must not grow an orchestration API.

## Delivery contract

- Address a mailbox by namespace and stable peer ID. A display name is an alias, not authority. Bind host session IDs separately; never infer a T3 thread solely from cwd or a shared provider environment.
- Store the envelope, idempotency receipt and notification-outbox row in one transaction. Return `stored` only after commit. Keep notification outcome separate from storage and acknowledgement.
- Scope a caller-supplied request key to the sender within the namespace. A retry with the same key and payload returns the original receipt. Reusing the key with changed recipient or payload returns a conflict. Equal text with different keys creates two messages.
- Make `inbox` non-destructive in the new protocol; add explicit `ack`. An acknowledgement means that the consumer acknowledged receipt, not that the model completed a task. Maintain stable ordering per mailbox, without promising global ordering or exactly-once model execution.
- Use at-least-once notification attempts and idempotent acknowledgements. Polling works without a notification adapter. Offline registered mailboxes can receive messages within storage limits; an unknown address is an error.
- Keep one canonical Relay inbox for messages sent through Relay. T3 receives unread notifications and the agent fetches the body via `peers`. Native T3 conversations remain native; Relay does not mirror them or write T3's database.
- Use Bun's built-in SQLite driver for a separate, versioned message database. Do not reuse or modify the existing launch-reservation database. Validate filesystem ownership and paths, then allow SQLite's normal recovery; do not copy the reservation database's raw pre-recovery integrity check into the message store.
- Start with local-disk WAL and `synchronous=FULL`, bounded busy waits and no network-filesystem support. Verify crash recovery on supported platforms. Do not hold a database transaction while calling a host.
- A small, explicitly started message dispatcher resumes pending notification jobs after restart. Without it, send/read/ack and polling still work, but unattended notification retries are paused. Delivery status and `doctor` must expose this condition.

The new protocol is an explicit pre-1.0 breaking release. Preserve `peers` and the `send/inbox/list` names; document the changed acknowledgement behavior, removed policy commands and migration. Preserve current envelope identifiers and reply relationships during import; support current field names at the compatibility boundary rather than mixing a field rename into every change.

## T3 proof of concept

Do this before expanding adapter work:

1. Use an isolated T3 environment with disposable state and two ordinary test threads. T3 creates and manages the threads; Relay only attaches mailboxes.
2. Prove per-thread binding for two threads sharing a checkout and provider. Test shared environment, provider restart and MCP reconnect. An ambiguous binding must report an error, never select another thread's mailbox.
3. Exchange messages through Relay in both directions and acknowledge them independently. Add a manual CLI peer for T3-to-terminal and terminal-to-T3 traffic.
4. Exercise an idle thread, a busy thread, a pending user question, T3 unavailable and a connection lost after T3 accepted a notification. Notifications must not answer user questions, interrupt work or create duplicate message bodies.
5. Select a supported, authenticated external T3 CLI/API route. The agent's injected MCP tool is not automatically callable by a background Relay process; do not borrow an expiring provider-session token or read T3's private database.
6. Where supported, pass a stable T3 request ID and an appropriate queued-notification mode. A separate `show`/`send` check is not proof against a concurrent user prompt. If the host cannot provide safe behavior, defer notifications and use polling until the integration is available. Report duplicate-notification risk separately from message idempotency.

Success is reliable addressing and delivery across the three peers. A PR-producing agent workflow is outside this messaging proof of concept. Record the tested T3 version and any capability gap instead of claiming compatibility from fake-host tests alone.

## Implementation sequence

### 1. Define boundaries and prove the T3 connection

Deliver the versioned message contract, dependency inventory and isolated proof-of-concept results. Specify session binding and dispatcher ownership before implementing them. Record current retry failure as a regression fixture: first append fails, then the identical retry reports success without a stored envelope.

Done when two same-checkout T3 threads have distinct Relay mailboxes and a manual peer exchanges messages with both, or the exact missing T3 capability is documented. A capability gap blocks that adapter, not work on the standalone message core. Do not merge a failing test into the normal gate; run the old-code failure separately as evidence.

### 2. Separate the message core and remove admission policy

Extract the message contracts and operations from `scripts/lead/peers/{types,bus,standaard}.ts` into the proposed modules. Replace imports from the lead register with a minimal directory interface. Remove `beleid()`, taint propagation, role-controlled hold/release and the conversation hop cap from the new runtime. Keep source compatibility wrappers only where needed during the transition.

Done when any two explicitly registered peers in one namespace exchange messages without lead relationships, and tests show that the core imports no lead, policy, Git, tmux or provider-hook modules. Message formatting contains no personal permission or workflow rules.

### 3. Make storage, retries and notifications transactional

Implement the versioned SQLite store and notification outbox. Replace content/time-window suppression with request-key idempotency. Add non-destructive reads, explicit ack, receipts, retention and the restartable dispatcher. Repair the known failed-send/retry behavior and carry its regression into the new backend.

Done when concurrent retries produce one stored envelope, different keys allow repeated text, failed persistence reserves no successful receipt, and crashes before/after commit or host acceptance recover correctly. A failed notification leaves the message readable and retryable; no successful storage receipt depends on host availability.

### 4. Connect host adapters and simplify hooks

Build the T3 adapter using the proven route and session binding. Extract Claude/Codex adapters from `wekker.ts` and the existing hook integrations. Hooks only register/bind a session, report presence and notify about unread messages. Use adapter capability detection; unsupported hosts poll. Presence means the host's observed state, not an inferred judgement that an agent finished its assignment.

Done when T3-to-T3, T3-to-CLI and CLI-to-T3 pass, and host failures cannot stop mailbox operations. No hook changes approval policy, checks shell commands, requires a lead role or forces an agent to report before stopping. Preserve startup-isolation and wrong-inbox regression coverage.

### 5. Remove legacy product scope and migrate installations

Remove the delivered `scripts/lead/beleid/`, `hooks/grenzen.sh`, merge/push/queue/spawn helpers, command runner, personal skills and related legacy launch code once no message module imports them. Replace today's broad installer copy with an explicit runtime manifest; installation must not ship governance code as inert baggage.

Update CLI/help/configuration, README and install/remove behavior. Use a new message-only hook marker. Do not remove shared `lab-lead-hooks` entries automatically: migrate only entries whose Relay ownership is proven, and leave unrelated project policy intact. Retire policy tests with a documented scope reason and add tests that policy files and imports are absent from the installed package. Keep historical source attribution; update manifest dispositions for files intentionally retired.

Provide a one-way, explicit import from legacy JSONL into a new state directory. Quiesce old writers, preserve message IDs and ack state, verify counts, make import idempotent and keep the source untouched. Previously held messages remain in an explicit legacy quarantine until the operator chooses an import action; removing policy must not silently deliver them. Never run old and new writers against one state directory. Rollback before new writes can return to the untouched source; after new writes, preserve/export the new store instead of pretending rollback is lossless.

Done when a fresh public HTTPS clone installs and exchanges messages without dev dependencies, tmux, lead roles or policy setup. A stale policy option produces an actionable migration error instead of being silently ignored.

### 6. Verify and release the messaging product

Run the reduced-scope full gate and CI on macOS/Linux, plus isolated real-host adapter checks. Cover disk-full/permission errors, process kills during SQLite commit, dispatcher restart, busy database, parallel writers/readers, wrong recipient, alias reuse, session reconnect, ack retry, pending user input and missing adapters. Preserve meaningful surviving startup, installation and identity tests; explain tests removed with the retired features.

Publish a versioned migration guide and a short installation path: install Relay, attach a peer, send, read, ack. Advertise only routes actually tested. There is no new hosted broker, remote-machine transport, orchestration scheduler or governance plugin system in this release.

## Execution boundaries

Implementation uses separate, explicitly bound workthreads and feature branches. It does not touch live message state or global hooks. The existing `main` bootstrap remains a separate pending repository task; do not retry its previously denied write through another transport. Follow the available approved review/publishing route.

After the contract is stable, storage and adapters can be separate owned workstreams, with integration and package cleanup owned by the lead. Each stream uses an isolated checkout and disposable host/state fixtures. No second orchestration layer is needed to implement the message layer.

## Sources

- [Relay bus at the reviewed baseline](https://github.com/bbawuah/relay/blob/3ad65ce16f4552c0423ff85f8b3a1bc14148d072/scripts/lead/peers/bus.ts): current mixed storage/admission implementation and attempt-based duplicate recording.
- [Relay host integration](https://github.com/bbawuah/relay/blob/3ad65ce16f4552c0423ff85f8b3a1bc14148d072/docs/configuration.md): current count-only T3 notifications and shared-provider identity constraints.
- [T3 transactional event sink](https://github.com/pingdotgg/t3code/blob/dac8b11ddc25bd5da62a367fdb6c3de777ae2986/apps/server/src/orchestration-v2/EventSink.ts): reference for atomic state, command receipts and effect outbox. This plan adopts the pattern, not T3's orchestration stack.
- [T3 orchestration MCP documentation](https://github.com/pingdotgg/t3code/blob/dac8b11ddc25bd5da62a367fdb6c3de777ae2986/docs/orchestration-v2/orchestrator-mcp-server.md): authenticated session-scoped app integration.
- [Bun SQLite documentation](https://bun.sh/docs/runtime/sqlite): built-in database driver and transactions.
