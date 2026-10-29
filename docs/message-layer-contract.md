# Parallel implementation contract

Lead: T3 thread `64847d95-5062-48cb-9506-4d3c9e7f19c5`. Plan: `message-layer-plan.md`. The shared types in `src/messages/contracts.ts` are owned by the lead. Changes to that seam require agreement from every affected stream before implementation.

## A: message service and directory

Own `src/messages/service.ts`, `src/directory/**`, `tests/messages-core.test.ts`, and `tests/message-directory.test.ts` only. Export `createMessageService({store, now?, id?, maxPending?, maxBodyBytes?})` with synchronous `send(SendRequest): Receipt`, `read({namespace,peerId,limit?}): Envelope[]`, `ack({namespace,peerId,ids}): number`, and `list(namespace): Peer[]`. Export `createDirectory({store,now?,id?})` with `register({namespace,name,endpoint,peerId?}): Peer` and `setPresence(namespace,peerId,presence): void`.

Defaults: namespace supplied explicitly, maximum body 16,000 UTF-8 bytes, maximum 1,000 unread messages per mailbox. Resolve names/IDs through the directory; aliases are case-insensitively unique within a namespace. Existing IDs/session targets must not silently acquire another binding. Missing/ambiguous identity is an error. Use SHA-256 of a canonical caller payload (resolved from/to plus supplied body/conversationId/replyTo) for `fingerprint`; exclude generated message/conversation IDs and time, so a retry without an explicit conversation ID works. A reply must refer to an existing same-namespace conversation in which the sender and recipient participate. No role, inbound policy, taint or reply-count gate. Do not implement storage, CLI or hooks.

## B: SQLite store and dispatcher

Own `src/storage/**`, `src/dispatch/**`, `tests/message-storage.test.ts`, and `tests/message-dispatch.test.ts` only. Export `createMessageStore({path,now?}): MessageStore`. Implement the exact shared interface with atomic register/alias uniqueness, enqueue/receipt/outbox, scoped reads/acks and ownership-checked notification leases. Use a dedicated new database, built-in `bun:sqlite`, local WAL, FULL sync, bounded waits, explicit schema/application ID, private paths and non-destructive refusal of unknown files. Allow SQLite recovery after filesystem validation; never deserialize or reuse the legacy reservation database.

Export `dispatchOnce({store,adapters,now?,workerId?,limit?,leaseMs?,maxAttempts?})`; return a summary `{claimed,sent,deferred,failed}`. No host operation inside a transaction. Jobs target immutable peer IDs/endpoint generations, not aliases. Claim expiration permits restart; completion/retry only succeeds for the claiming worker. Deferred routes remain retryable; unsupported/exhausted jobs must retain a diagnosis. No content is passed to adapters. Preserve successful retry receipts through message retention. Do not implement importer or an always-on server in this first slice; report their integration needs.

## C: T3 adapter and connection feasibility

Own `src/adapters/**`, `tests/message-adapters.test.ts`, and `docs/t3-message-poc.md` only. Implement `createT3Adapter(...)` returning the shared `MessageAdapter`, with injected process/transport helpers for tests. Use explicit T3 session binding and count-only notifications. Document the supported external CLI/API route, authentication lifetime, stable request-ID availability, pending-user-question behavior, and the difference between a built-in tool and a callable external API. Do not borrow agent credentials, write T3's database, edit provider settings, or use current live threads as test targets.

A separate show/send check has a race; do not claim a pending-question guarantee from it. Where the installed host cannot provide a proven safe route, return deferred/unsupported and document polling. Use isolated fake-host tests now. A real-host probe may only use a disposable environment and explicitly identified test threads; report missing prerequisites to the lead before creating any extra test threads. Include same-checkout/shared-provider/reconnect identity risks, even if the live proof is unavailable. Do not implement agent spawning or merge workflows.

## Lead integration

Own shared contracts, `src/cli.ts`, `src/mcp/**`, packaging, installer, environment, legacy hook retirement, importer and documentation outside C's file. Integration order A, B, C; all streams start from the same committed seam and use fakes for unavailable implementations. Then the lead wires the runtime, retires policy/orchestration source with test-removal reasons, runs independent review and the full gate. Workers do not push or open PRs in this round.

## Shared boundaries and handoff

- First verify the bound worktree/branch, baseline, Bun and Git; read AGENTS, plan, this contract and your full brief. Send a three-line acceptance to the lead and wait for an explicit GO before code changes.
- Work only in your file ownership; do not create subagents, change contracts, touch other worktrees, install global settings, inspect secrets, push, merge, deploy or bypass hooks/roles. Ordinary local commits keep all hooks enabled.
- Test only isolated HOME/state/prefix/cwd/ports/sockets. Targeted tests and typecheck are allowed; the full gate belongs to the lead. Dependency installation, if required, is frozen and ignores scripts in the worker's own checkout with temporary cache/home.
- Searches use `rg --glob '!config.properties' --glob '!config.json' --glob '!.env*'` with exclusions before the pattern/path. Do not read those excluded files or key directories.
- Stop and report any tool/boundary refusal or missing capability; no alternative transport, permission change, hook override or role change. Preserve work and evidence. A missing implementation from another stream is not permission to edit it.
- First implementation slice has a 25-minute deadline from GO. Deliver a normal local commit if ready; otherwise preserve partial work and report it. Provide exact SHA, clean/dirty state, tests and limits, worktree path, and `STATUS-A/B/C.md` at the external handoff directory from your brief. Send the summary to the lead through `t3_thread_send`; the external status file is the fallback.
