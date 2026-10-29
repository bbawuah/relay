import { randomUUID } from "node:crypto";
import { MessageError, type MessageAdapter, type MessageStore } from "../messages/contracts";

export async function dispatchOnce({ store, adapters, now = Date.now, workerId = randomUUID(), limit = 25, leaseMs = 30_000, maxAttempts = 5 }: {
  store: MessageStore; adapters: readonly MessageAdapter[]; now?: () => number; workerId?: string;
  limit?: number; leaseMs?: number; maxAttempts?: number;
}): Promise<{ claimed: number; sent: number; deferred: number; failed: number }> {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new MessageError("invalid", "Invalid notification attempt limit");
  const hosts = new Map<string, MessageAdapter>();
  for (const adapter of adapters) {
    if (hosts.has(adapter.host)) throw new MessageError("conflict", `Ambiguous notification host: ${adapter.host}`);
    hosts.set(adapter.host, adapter);
  }
  const jobs = store.claimNotifications({ now: now(), workerId, limit, leaseMs });
  const summary = { claimed: jobs.length, sent: 0, deferred: 0, failed: 0 };
  for (const job of jobs) {
    const retry = (detail: string, permanent: boolean, delay?: number, deferred = false) => {
      const backoff = delay !== undefined && Number.isFinite(delay) && delay >= 0
        ? Math.min(delay, 86_400_000) : Math.min(1000 * 2 ** Math.min(job.attempts - 1, 12), 3_600_000);
      const attempts = permanent ? 1 : deferred ? Number.MAX_SAFE_INTEGER : maxAttempts;
      const changed = store.retryNotification({ id: job.id, workerId, availableAt: now() + Math.ceil(backoff), error: detail, maxAttempts: attempts });
      if (!changed || permanent || (!deferred && job.attempts >= maxAttempts)) summary.failed++;
      else summary.deferred++;
    };
    const peer = store.getPeer(job.namespace, job.peerId);
    if (!peer || JSON.stringify(peer.endpoint) !== JSON.stringify(job.endpoint)) { retry("Notification endpoint binding changed or disappeared", true); continue; }
    const unread = store.unread(job.namespace, job.peerId);
    if (unread === 0) {
      if (store.completeNotification(job.id, workerId)) summary.sent++; else summary.failed++;
      continue;
    }
    const adapter = hosts.get(job.endpoint.host);
    if (!adapter) { retry(`No notification adapter for ${job.endpoint.host}; polling remains available`, false, undefined, true); continue; }
    // claimNotifications committed before any external host work starts.
    let result;
    try { result = await adapter.notify({ notificationId: job.id, namespace: job.namespace, peerId: job.peerId, endpoint: job.endpoint, unread }); }
    catch (cause) { retry(`Notification failed: ${cause instanceof Error ? cause.message : String(cause)}`, false); continue; }
    if (result.status === "sent") {
      if (store.completeNotification(job.id, workerId)) summary.sent++; else summary.failed++;
    } else if (result.status === "deferred") retry(result.detail ?? "Host deferred notification", false, result.retryAfterMs, true);
    else retry(result.detail ?? "Host does not support notifications", true);
  }
  return summary;
}
