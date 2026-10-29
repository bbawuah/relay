import { createHash } from "node:crypto";
import type { MessageAdapter, Notification, NotifyResult } from "../messages/contracts.ts";

export const T3_HOST = "t3";
export const T3_DEFAULT_TIMEOUT_MS = 10_000;
export const T3_DEFAULT_RETRY_MS = 30_000;

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * What a transport proves about the host route. Both must be true before the
 * adapter sends anything: a retry after a lost reply is only harmless with a
 * stable request ID, and a queued notification is only safe for a thread with
 * a pending user question when the host itself refuses it atomically. A
 * separate show-then-send check cannot provide the second property.
 */
export type T3Capabilities = {
  stableRequestId: boolean;
  pendingSafeSend: boolean;
  /** Tested host version, reported in diagnoses. */
  hostVersion?: string;
};

export type T3SendInput = {
  threadId: string;
  /** Count-only text. Never contains message bodies, senders or peer names. */
  text: string;
  /** Stable per notification job; the host must replay it as the same work. */
  requestId: string;
  signal: AbortSignal;
};

export type T3SendOutcome =
  /** The host accepted it durably (started, steered or queued behind a run). */
  | { status: "accepted" }
  /** The host refused because the thread has a pending user question or approval. */
  | { status: "pending_request" };

export type T3FailureKind =
  /** Host not running or unreachable. */
  | "unavailable"
  /** Credential missing, expired or revoked. */
  | "unauthenticated"
  /** The thread does not exist (any more) or may not be addressed. */
  | "unknown_thread"
  /** The host answered but declined for a lasting reason. */
  | "rejected";

export class T3TransportError extends Error {
  constructor(readonly kind: T3FailureKind, message: string) {
    super(message);
    this.name = "T3TransportError";
  }
}

/** Authenticated external route to T3. Implemented by the app integration. */
export interface T3Transport {
  readonly capabilities: T3Capabilities;
  send(input: T3SendInput): Promise<T3SendOutcome>;
}

export type T3AdapterOptions = {
  /** Without a transport every notification is unsupported and mailboxes poll. */
  transport?: T3Transport;
  timeoutMs?: number;
  retryAfterMs?: number;
};

export function t3NotificationText(unread: number): string {
  return `Relay: ${unread} unread message${unread === 1 ? "" : "s"}. Read them with the peers inbox tool; this notice is not a task.`;
}

/** Same job id gives the same request ID, so a retry replays the same host work. */
export function t3RequestId(notificationId: string): string {
  return `relay-notify-${createHash("sha256").update(notificationId).digest("hex").slice(0, 32)}`;
}

/** Only an explicit, immutable T3 binding is accepted; never cwd or environment. */
export function resolveT3Thread(notification: Notification): { threadId: string } | { reason: string } {
  const { endpoint } = notification;
  if (endpoint.host !== T3_HOST) return { reason: `endpoint host is ${JSON.stringify(endpoint.host)}, not t3` };
  const threadId = endpoint.target.threadId;
  if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) return { reason: "endpoint has no valid target.threadId" };
  if (endpoint.sessionId !== threadId) return { reason: "endpoint sessionId and target.threadId disagree; binding is ambiguous" };
  return { threadId };
}

function safeDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 200);
}

export function createT3Adapter(options: T3AdapterOptions = {}): MessageAdapter {
  const { transport } = options;
  const timeoutMs = options.timeoutMs ?? T3_DEFAULT_TIMEOUT_MS;
  const retryAfterMs = options.retryAfterMs ?? T3_DEFAULT_RETRY_MS;

  const unsupported = (detail: string): NotifyResult => ({ status: "unsupported", detail });
  const deferred = (detail: string): NotifyResult => ({ status: "deferred", detail, retryAfterMs });

  return {
    host: T3_HOST,
    async notify(notification: Notification): Promise<NotifyResult> {
      try {
        if (!Number.isSafeInteger(notification.unread) || notification.unread < 1) {
          return unsupported("nothing unread to announce");
        }
        const bound = resolveT3Thread(notification);
        if ("reason" in bound) return unsupported(bound.reason);
        if (!transport) {
          return unsupported("no authenticated external T3 route configured; mailbox is polled with the peers inbox tool");
        }
        const { capabilities } = transport;
        if (!capabilities.stableRequestId) return unsupported("T3 route has no stable request ID; a lost reply could duplicate the notice, polling instead");
        if (!capabilities.pendingSafeSend) return unsupported("T3 route cannot refuse a notice for a pending user question atomically; polling instead");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const outcome = await Promise.race([
            transport.send({
              threadId: bound.threadId,
              text: t3NotificationText(notification.unread),
              requestId: t3RequestId(notification.notificationId),
              signal: controller.signal,
            }),
            new Promise<never>((_, reject) => {
              controller.signal.addEventListener("abort", () => reject(new T3TransportError("unavailable", `no T3 answer within ${timeoutMs} ms; outcome unknown, retry is idempotent`)), { once: true });
            }),
          ]);
          return outcome.status === "accepted" ? { status: "sent" } : deferred("thread has a pending user question; not notified");
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (error instanceof T3TransportError) {
          if (error.kind === "unknown_thread") return unsupported(`T3 thread unknown: ${safeDetail(error)}`);
          if (error.kind === "rejected") return unsupported(`T3 rejected the notice: ${safeDetail(error)}`);
          return deferred(`T3 ${error.kind}: ${safeDetail(error)}`);
        }
        return deferred(`T3 route failed: ${safeDetail(error)}`);
      }
    },
  };
}
