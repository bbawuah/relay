# T3 message adapter: feasibility and current state

Status 29 October 2026. Branch `feat/message-t3`, baseline `be5280d`. **No live T3 integration is proven.** The adapter (`src/adapters/t3.ts`) is tested only against an isolated fake host (`tests/message-adapters.test.ts`). Those tests prove the adapter's decisions, not T3's behavior. No T3 process, thread, database, provider setting or credential was touched.

## What the adapter does

`createT3Adapter({transport?, timeoutMs?, retryAfterMs?})` returns the shared `MessageAdapter` with `host: "t3"`.

- Binding is explicit: `endpoint.target.threadId` must be a well-formed thread ID and equal `endpoint.sessionId`. Anything else is `unsupported`. cwd, provider and environment never select a thread.
- The notice is count-only (`t3NotificationText`): no body, sender, peer name or namespace. The agent fetches content through `peers`.
- The request ID is `relay-notify-<sha256(notificationId)>`: the same outbox job always replays the same host request.
- It sends only through an injected `T3Transport` that declares **both** `stableRequestId` and `pendingSafeSend`. Otherwise it returns `unsupported` with a diagnosis and the mailbox is polled.
- Outcomes: exactly `accepted` → `sent`; exactly `pending_request` → `deferred`. Any other host answer (unknown status, `null`, a non-object) is a generic retryable `deferred` protocol error, never reported as a pending question. Host down, expired credential, timeout and unclassified errors → `deferred` (message stays readable); unknown thread, host rejection, unusable `notificationId` and bad binding → `unsupported`. `notify` never throws, including for hostile thrown values, getters and proxies.
- Diagnoses are fixed texts (`T3_DIAGNOSTICS`, all under 160 characters). No transport error message, thrown value, host body, outcome field or endpoint value is ever copied into a diagnosis, so credentials (Bearer, Basic, cookies, `access_token`, JWTs) cannot reach the dispatcher's stored errors. Only the closed `T3TransportError.kind` is read; its `message` is for the transport's own logs.
- Config is validated when the adapter is created: `timeoutMs` is an integer 1 to 120000 and `retryAfterMs` an integer 1 to 86400000 (defaults 10000 and 30000); anything else throws `RangeError` before any host call. `notificationId` must be a string of 1 to 256 characters, and it must be `NotificationJob.id`, stable across attempts and lease re-claims (the dispatcher's duty, see the review's S1), or retries would not replay the same host request. Capability flags must be exactly `true`.
- `notify(notification, signal?)` honors the dispatcher's cancellation. An already-aborted signal is `deferred` before any host call (nothing sent). An abort while the transport call is pending aborts the transport's own signal and returns `deferred` with a fixed "outcome unknown, retry is idempotent" text; the retry uses the same request ID. The adapter's own deadline still applies. The timer and the abort listener are always released, and the dispatcher's signal object itself is never handed to the transport.
- A timeout after the host may have accepted is `deferred`. The retry is harmless only because the request ID is stable, which is why the adapter refuses transports without one.

Duplicate-notification risk is separate from message idempotency: a stored message is never duplicated by a notice, but a notice without a stable request ID could be delivered twice after a lost reply.

## Supported external route (public sources)

Read from the public T3 repository at commit `dac8b11ddc25bd5da62a367fdb6c3de777ae2986` (`docs/orchestration-v2/orchestrator-mcp-server.md`, `docs/internals/environment-auth.md`, `apps/server/src/cli/thread.ts`). The locally installed runtime directory is named `0.1.2`; I listed that directory name only, did not execute the binary, and did not check that it matches this commit. Compatibility with the installed version is **unverified**.

### Built-in tool is not a callable external API

The `t3-code` MCP tools (`t3_thread_send`, `t3_thread_read`, …) are injected into a provider session. Their bearer credential is scoped to environment, parent thread, provider instance and provider session, expires (maximum lifetime and idle timeout) and is revoked when the session is released; it is passed through `T3_MCP_BEARER_TOKEN` or a header. A background Relay process must not read or reuse it, and an agent being able to call the tool does not make it an API Relay can call. Tools also require the calling thread's live run to change another thread.

### Route 1: `t3 thread send` CLI

The CLI mints its own owner-level session (`access: "full-access"`, label `t3 thread cli`) from the local T3 base-dir runtime state, revokes it at exit, and sends with a hard-coded `mode: "queue"`. It exposes **no request-ID option**, and `thread show` followed by `thread send` is two calls: a user prompt or question can arrive between them. It therefore cannot declare `stableRequestId` or `pendingSafeSend`, and it also depends on access to T3's private state directory. It is not used. The earlier Relay wake-up code used this route; do not treat it as proven safe.

### Route 2: authenticated MCP client over `/mcp` (candidate)

`/mcp` accepts agents T3 did not launch through an OAuth authorization-code flow: loopback redirect, PKCE, public client, approved by the owner with a one-time pairing code or an authenticated browser session. The owner grants read-only access or a runtime-mode ceiling; the session has subject `mcp-client` and works on `/mcp` only. `t3_thread_send` accepts `clientRequestId`, from which stable command and message IDs are derived, so retries return the same durable work. This is the only documented route that offers a stable request ID to a non-agent client.

Open before it can be used (all unverified, need a disposable T3):

1. **Authentication lifetime.** Lifetime, idle timeout and refresh of an `mcp-client` session are not stated in the pages read. Relay needs a token stored privately by the operator and a way to renew it; an expired token must surface as `deferred`, not silent loss.
2. **Request-ID scope.** The docs say IDs are derived "within the provider session". Whether an OAuth client's retries across reconnects or restarts replay the same work is unproven.
3. **Live-run requirement.** The docs say a tool that changes another thread needs the calling thread's live run. An external client has no run; this may block `t3_thread_send` entirely.
4. **Pending user question.** No send mode refuses when the target has a pending request. `t3_pending_request_list` exists, but a separate check then send is racy and gives no guarantee. The legacy Relay code cites an upstream T3 issue (#15517, not verified here) that sending to a thread with an open question can leave it stuck. The adapter needs a host-side atomic refusal, or must defer.
5. **Busy thread.** `queue` documents a separate follow-up run after active work; `auto` may steer. Only `queue` should be used, and the effect on an idle thread must be checked.

Until 1 to 5 are shown on a disposable environment, the app integration must leave `capabilities.pendingSafeSend` false and the adapter stays `unsupported`, so mailboxes are polled.

## Polling fallback

Without a proven route every T3 mailbox is polled: `send`, `read` and `ack` work without any notification. The dispatcher records the `unsupported` diagnosis on the job. Presence and unread counts remain visible to peers that poll.

## Identity risks (tested only against the fake host)

- Same checkout, shared provider: threads share cwd and provider environment. A per-thread mailbox needs an explicit thread ID from registration; the adapter refuses to infer it. A shared MCP server with a fixed name routes several threads into one inbox, which is the risk `docs/configuration.md` already notes.
- Reconnect: a reconnecting session must register through the same immutable binding. A different `sessionId` for an existing `threadId` is ambiguous and is refused (`unsupported`), never redirected to another mailbox.
- Provider restart: a restarted provider session may get a new MCP credential but must keep the thread ID. The adapter holds no credential; the injected transport owns authentication.
- Thread deletion: `unknown_thread` becomes `unsupported`, so the dispatcher stops retrying a dead binding.

## What a live proof needs (not done, nothing was bypassed)

A disposable T3 server with its own base directory and ports, two ordinary test threads that share one checkout and provider, created by the operator or approved by the lead beforehand, and an authenticated MCP client approved by the owner. Checks: per-thread binding, restart and reconnect, idle thread, busy thread, pending question, host down, connection lost after acceptance. No such environment or approval existed in this round, and no extra thread was created.

## App integration still required (lead-owned)

A `T3Transport` implementation for the chosen route with credential storage and renewal, registration that records `target.threadId` equal to `sessionId`, and a doctor line showing "T3 notifications: unsupported, polling" while the capabilities are unproven.
