import { createHash } from "node:crypto";
import type { MessageAdapter, Notification, NotifyResult } from "../messages/contracts.ts";

export const T3_HOST = "t3";
export const T3_DEFAULT_TIMEOUT_MS = 10_000;
export const T3_DEFAULT_RETRY_MS = 30_000;
export const T3_MAX_TIMEOUT_MS = 120_000;
export const T3_MAX_RETRY_MS = 86_400_000;
export const T3_MAX_NOTIFICATION_ID_LENGTH = 256;

const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Every diagnosis the adapter can produce. Nothing from the host, the
 * transport, a thrown value or the endpoint is ever copied into a diagnosis, so
 * credentials and unbounded text cannot reach the dispatcher's stored errors.
 */
export const T3_DIAGNOSTICS = {
  nothingUnread: "nothing unread to announce",
  badNotificationId: "notification has no usable id; cannot derive a stable T3 request ID",
  badHost: "endpoint host is not t3",
  badThread: "endpoint has no valid target.threadId",
  ambiguousBinding: "endpoint sessionId and target.threadId disagree; binding is ambiguous",
  unreadableBinding: "endpoint binding is unreadable",
  noTransport: "no authenticated external T3 route configured; mailbox is polled with the peers inbox tool",
  noRequestId: "T3 route has no stable request ID; a lost reply could duplicate the notice, polling instead",
  notPendingSafe: "T3 route cannot refuse a notice for a pending user question atomically; polling instead",
  pendingQuestion: "thread has a pending user question; not notified",
  cancelledBeforeSend: "dispatcher cancelled before the T3 request; nothing was sent",
  cancelled: "dispatcher cancelled while waiting for T3; outcome unknown, retry is idempotent",
  timeout: "no T3 answer within the time budget; outcome unknown, retry is idempotent",
  unknownOutcome: "T3 route returned an unrecognized outcome; will retry",
  unavailable: "T3 host unavailable; will retry",
  unauthenticated: "T3 credential missing or expired; will retry",
  unknownThread: "T3 thread unknown; binding is stale",
  rejected: "T3 rejected the notice",
  routeFailed: "T3 route failed with an unclassified error; will retry",
} as const;

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
  /** Tested host version, reported in documentation, never in diagnoses. */
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

/** Only `kind` is used by the adapter; the message is for the transport's own logs. */
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
  /** Integer milliseconds, 1..T3_MAX_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Integer milliseconds, 1..T3_MAX_RETRY_MS. */
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
  try {
    const { endpoint } = notification;
    if (endpoint.host !== T3_HOST) return { reason: T3_DIAGNOSTICS.badHost };
    const threadId = endpoint.target.threadId;
    if (typeof threadId !== "string" || !THREAD_ID.test(threadId)) return { reason: T3_DIAGNOSTICS.badThread };
    if (endpoint.sessionId !== threadId) return { reason: T3_DIAGNOSTICS.ambiguousBinding };
    return { threadId };
  } catch {
    return { reason: T3_DIAGNOSTICS.unreadableBinding };
  }
}

function boundedInteger(name: string, value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`createT3Adapter: ${name} must be an integer from 1 to ${max}`);
  }
  return value;
}

/** Reads only the closed `kind` field; a hostile value falls through to "unclassified". */
function failureKind(error: unknown): T3FailureKind | null {
  try {
    if (error instanceof T3TransportError) {
      const kind = error.kind;
      if (kind === "unavailable" || kind === "unauthenticated" || kind === "unknown_thread" || kind === "rejected") return kind;
    }
  } catch {
    // fall through
  }
  return null;
}

const TIMED_OUT = Symbol("t3-timeout");
const CANCELLED = Symbol("t3-cancelled");

export function createT3Adapter(options: T3AdapterOptions = {}): MessageAdapter {
  const transport = options.transport;
  const timeoutMs = boundedInteger("timeoutMs", options.timeoutMs, T3_DEFAULT_TIMEOUT_MS, T3_MAX_TIMEOUT_MS);
  const retryAfterMs = boundedInteger("retryAfterMs", options.retryAfterMs, T3_DEFAULT_RETRY_MS, T3_MAX_RETRY_MS);

  const unsupported = (detail: string): NotifyResult => ({ status: "unsupported", detail });
  const deferred = (detail: string): NotifyResult => ({ status: "deferred", detail, retryAfterMs });

  return {
    host: T3_HOST,
    async notify(notification: Notification, external?: AbortSignal): Promise<NotifyResult> {
      try {
        if (!Number.isSafeInteger(notification.unread) || notification.unread < 1) return unsupported(T3_DIAGNOSTICS.nothingUnread);
        const notificationId = notification.notificationId;
        if (typeof notificationId !== "string" || notificationId.length < 1 || notificationId.length > T3_MAX_NOTIFICATION_ID_LENGTH) {
          return unsupported(T3_DIAGNOSTICS.badNotificationId);
        }
        const bound = resolveT3Thread(notification);
        if ("reason" in bound) return unsupported(bound.reason);
        if (!transport) return unsupported(T3_DIAGNOSTICS.noTransport);
        const { capabilities } = transport;
        if (capabilities.stableRequestId !== true) return unsupported(T3_DIAGNOSTICS.noRequestId);
        if (capabilities.pendingSafeSend !== true) return unsupported(T3_DIAGNOSTICS.notPendingSafe);

        // Last gate before the host: an already-cancelled dispatcher never reaches it.
        if (external?.aborted === true) return deferred(T3_DIAGNOSTICS.cancelledBeforeSend);

        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        try {
          const interrupted = new Promise<typeof TIMED_OUT | typeof CANCELLED>((resolve) => {
            timer = setTimeout(() => {
              controller.abort();
              resolve(TIMED_OUT);
            }, timeoutMs);
            if (external) {
              onAbort = () => {
                controller.abort();
                resolve(CANCELLED);
              };
              external.addEventListener("abort", onAbort, { once: true });
            }
          });
          const outcome: unknown = await Promise.race([
            transport.send({
              threadId: bound.threadId,
              text: t3NotificationText(notification.unread),
              requestId: t3RequestId(notificationId),
              signal: controller.signal,
            }),
            interrupted,
          ]);
          if (outcome === CANCELLED) return deferred(T3_DIAGNOSTICS.cancelled);
          if (outcome === TIMED_OUT) return deferred(T3_DIAGNOSTICS.timeout);
          const status = typeof outcome === "object" && outcome !== null ? (outcome as { status?: unknown }).status : undefined;
          if (status === "accepted") return { status: "sent" };
          if (status === "pending_request") return deferred(T3_DIAGNOSTICS.pendingQuestion);
          return deferred(T3_DIAGNOSTICS.unknownOutcome);
        } finally {
          clearTimeout(timer);
          if (onAbort) {
            try {
              external?.removeEventListener("abort", onAbort);
            } catch {
              // a hostile signal must not turn cleanup into a rejection
            }
          }
        }
      } catch (error) {
        switch (failureKind(error)) {
          case "unknown_thread":
            return unsupported(T3_DIAGNOSTICS.unknownThread);
          case "rejected":
            return unsupported(T3_DIAGNOSTICS.rejected);
          case "unauthenticated":
            return deferred(T3_DIAGNOSTICS.unauthenticated);
          case "unavailable":
            return deferred(T3_DIAGNOSTICS.unavailable);
          default:
            return deferred(T3_DIAGNOSTICS.routeFailed);
        }
      }
    },
  };
}
