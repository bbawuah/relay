/** Message protocol v2. Shared integration seam, owned by the lead. */
export const PROTOCOL_VERSION = 2 as const;
export const DEFAULT_IDEMPOTENCY_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_REFERENCE_MS = 30 * 24 * 60 * 60 * 1000;

export type Presence = "online" | "busy" | "idle" | "offline";

/** Host references are routing data, never permission or role information. */
export type Endpoint = {
  host: string;
  sessionId: string;
  generation: number;
  target: Record<string, string>;
};

export type Peer = {
  id: string;
  namespace: string;
  name: string;
  endpoint: Endpoint;
  presence: Presence;
  registeredAt: number;
  lastSeenAt: number;
};

export type Envelope = {
  version: typeof PROTOCOL_VERSION;
  id: string;
  namespace: string;
  from: string;
  to: string;
  conversationId: string;
  replyTo?: string;
  createdAt: number;
  body: string;
};

export type SendRequest = {
  namespace: string;
  from: string;
  to: string;
  body: string;
  conversationId?: string;
  replyTo?: string;
  requestKey?: string;
};

export type Receipt = {
  id: string;
  state: "stored";
  duplicate: boolean;
  createdAt: number;
  /** Request-key retries are guaranteed only before this UTC epoch time. */
  expiresAt: number;
  requestKey?: string;
};

/** Reply context survives body retention for a documented, bounded lifetime. */
export type MessageReference = Pick<Envelope, "id" | "namespace" | "from" | "to" | "conversationId" | "createdAt">;

export type EnqueueInput = {
  message: Envelope;
  requestKey?: string;
  /** SHA-256 of caller payload, excluding generated IDs/timestamps. */
  fingerprint: string;
  maxPending: number;
  maxBodyBytes: number;
};

export type NotificationJob = {
  id: string;
  namespace: string;
  peerId: string;
  endpoint: Endpoint;
  messageId: string;
  attempts: number;
  failures: number;
  availableAt: number;
};

export type NotificationState = "pending" | "sent" | "unsupported" | "failed" | "empty" | "superseded";
export type NotificationStatus = {
  id: string;
  namespace: string;
  peerId: string;
  state: NotificationState;
  attempts: number;
  failures: number;
  availableAt: number;
  leaseUntil?: number;
  /** Fixed, bounded diagnosis; never raw host errors or credentials. */
  detail?: string;
};

export type Notification = {
  /** Exactly NotificationJob.id, globally unique and stable across retries. */
  notificationId: string;
  namespace: string;
  peerId: string;
  endpoint: Endpoint;
  unread: number;
};

export type NotifyResult = {
  status: "sent" | "deferred" | "unsupported";
  detail?: string;
  retryAfterMs?: number;
};

export interface MessageAdapter {
  readonly host: string;
  notify(notification: Notification, signal?: AbortSignal): Promise<NotifyResult>;
}

/** Synchronous local transactions; no host/network call runs inside one. */
export interface MessageStore {
  /** Immutable binding; conflicting IDs, aliases or session targets throw. */
  register(peer: Peer): Peer;
  /** Explicit CAS reconnect; generation must advance by one, alias/ID stay fixed. */
  rebindPeer(namespace: string, id: string, expectedGeneration: number, endpoint: Endpoint, now: number): Peer;
  getPeer(namespace: string, id: string): Peer | null;
  findPeer(namespace: string, name: string): Peer | null;
  listPeers(namespace: string): Peer[];
  setPresence(namespace: string, id: string, presence: Presence, now: number): void;
  /** Lookup before reply validation; mismatch throws conflict, absent returns null. */
  lookupReceipt(namespace: string, senderId: string, requestKey: string, fingerprint: string): Receipt | null;
  /** Message + request-key receipt + outbox job commit atomically. */
  enqueue(input: EnqueueInput): Receipt;
  getMessage(namespace: string, id: string): Envelope | null;
  getMessageReference(namespace: string, id: string): MessageReference | null;
  /** Only unacknowledged envelopes, ordered within this recipient's mailbox. */
  read(namespace: string, peerId: string, limit?: number): Envelope[];
  /** Unknown/foreign/already acknowledged IDs are ignored and count as zero. */
  ack(namespace: string, peerId: string, ids: string[], now: number): number;
  unread(namespace: string, peerId: string): number;
  claimNotifications(input: { now: number; workerId: string; leaseMs: number; limit: number }): NotificationJob[];
  completeNotification(id: string, workerId: string, state?: "sent" | "empty"): boolean;
  failNotification(id: string, workerId: string, detail: string, state?: "failed" | "unsupported" | "superseded"): boolean;
  retryNotification(input: { id: string; workerId: string; availableAt: number; error: string; maxAttempts: number; countFailure?: boolean }): boolean;
  notificationStatus(namespace: string, peerId?: string): NotificationStatus[];
  /** Remove old acknowledged bodies and expired metadata/terminal diagnoses.
   * Never expire unread bodies or pending jobs. Returns removed-body count. */
  prune(before: number): number;
  close(): void;
}

export type MessageErrorCode =
  | "invalid"
  | "unknown_peer"
  | "conflict"
  | "too_large"
  | "queue_full"
  | "storage";

export class MessageError extends Error {
  constructor(readonly code: MessageErrorCode, message: string) {
    super(message);
    this.name = "MessageError";
  }
}
