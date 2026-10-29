import { randomUUID } from "node:crypto";
import { MessageError, type MessageAdapter, type MessageStore } from "../messages/contracts";
import { DIAG } from "../storage/diagnostics";

const MARGIN_MS = 1000;
type Outcome = { status: "sent" | "deferred" | "unsupported"; delay?: number } | { status: "error"; detail: string };
async function notify(adapter: MessageAdapter, payload: Parameters<MessageAdapter["notify"]>[0], timeoutMs: number): Promise<Outcome> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<Outcome>(resolve => {
    timer = setTimeout(() => {
      resolve({ status: "error", detail: DIAG.timeout });
      try { controller.abort(); } catch { /* Never inspect a host callback's thrown value. */ }
    }, timeoutMs);
  });
  const operation = (async (): Promise<Outcome> => {
    let result: unknown;
    try { result = await adapter.notify(payload, controller.signal); }
    catch { return { status: "error", detail: DIAG.failed }; }
    try {
      if (!result || typeof result !== "object") return { status: "error", detail: DIAG.invalid };
      const { status, retryAfterMs } = result as { status?: unknown; retryAfterMs?: unknown };
      if (status !== "sent" && status !== "deferred" && status !== "unsupported") return { status: "error", detail: DIAG.invalid };
      if (retryAfterMs !== undefined && (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs))) return { status: "error", detail: DIAG.invalid };
      const delay = retryAfterMs === undefined ? undefined : Math.ceil(Math.max(1000, Math.min(retryAfterMs as number, 86_400_000)));
      return { status, delay };
    } catch { return { status: "error", detail: DIAG.invalid }; }
  })();
  try { return await Promise.race([deadline, operation]); }
  finally { clearTimeout(timer); }
}

export async function dispatchOnce({ store, adapters, now = Date.now, workerId = randomUUID(), limit = 25, leaseMs = 30_000, maxAttempts = 5, timeoutMs = 10_000 }: {
  store: MessageStore; adapters: readonly MessageAdapter[]; now?: () => number; workerId?: string;
  limit?: number; leaseMs?: number; maxAttempts?: number; timeoutMs?: number;
}): Promise<{ claimed: number; sent: number; deferred: number; failed: number; empty: number }> {
  for (const [value, min, max] of [[limit, 0, 1000], [leaseMs, 1, 86_400_000], [maxAttempts, 1, 1000], [timeoutMs, 1, 60_000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new MessageError("invalid", "Invalid dispatcher options");
  }
  if (leaseMs <= timeoutMs + MARGIN_MS || typeof workerId !== "string" || !workerId.trim() || workerId.includes("\0")) throw new MessageError("invalid", "Invalid dispatcher lease or worker ID");
  const hosts = new Map<string, MessageAdapter>();
  try {
    if (!Array.isArray(adapters)) throw new Error();
    for (const adapter of adapters) {
      const host = adapter.host;
      if (typeof host !== "string" || !host.trim() || typeof adapter.notify !== "function") throw new Error();
      if (hosts.has(host)) throw new Error();
      hosts.set(host, adapter);
    }
  } catch { throw new MessageError("invalid", "Invalid or duplicate notification adapters"); }
  const clock = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new MessageError("invalid", "Invalid dispatcher time");
    return value;
  };
  const summary = { claimed: 0, sent: 0, deferred: 0, failed: 0, empty: 0 };
  for (let index = 0; index < limit; index++) {
    // Each lease starts immediately before its own bounded host operation.
    const [job] = store.claimNotifications({ now: clock(), workerId, limit: 1, leaseMs });
    if (!job) break;
    summary.claimed++;
    const peer = store.getPeer(job.namespace, job.peerId);
    if (!peer || peer.endpoint.generation !== job.endpoint.generation) {
      store.failNotification(job.id, workerId, DIAG.superseded, "superseded"); summary.failed++; continue;
    }
    const unread = store.unread(job.namespace, job.peerId);
    if (unread === 0) {
      if (store.completeNotification(job.id, workerId, "empty")) summary.empty++; else summary.failed++;
      continue;
    }
    const adapter = hosts.get(job.endpoint.host);
    const result: Outcome = adapter ? await notify(adapter, { notificationId: job.id, namespace: job.namespace, peerId: job.peerId, endpoint: job.endpoint, unread }, timeoutMs)
      : { status: "deferred" };
    if (result.status === "sent") {
      if (store.completeNotification(job.id, workerId)) summary.sent++; else summary.failed++;
    } else if (result.status === "unsupported") {
      store.failNotification(job.id, workerId, DIAG.unsupported, "unsupported"); summary.failed++;
    } else if (result.status === "error" && job.failures + 1 >= maxAttempts) {
      store.failNotification(job.id, workerId, result.detail, "failed"); summary.failed++;
    } else {
      const failed = result.status === "error";
      const backoff = Math.min(1000 * 2 ** Math.min(failed ? job.failures : job.attempts - 1, 12), 3_600_000);
      const delay = result.status === "deferred" && result.delay !== undefined ? result.delay : backoff;
      const changed = store.retryNotification({ id: job.id, workerId, availableAt: clock() + delay, maxAttempts, countFailure: failed,
        error: result.status === "error" ? result.detail : adapter ? DIAG.deferred : DIAG.missing });
      if (failed || !changed) summary.failed++; else summary.deferred++;
    }
  }
  return summary;
}
