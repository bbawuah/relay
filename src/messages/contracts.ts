/** Message protocol v2. Shared integration seam, owned by the lead. */
export const PROTOCOL_VERSION = 2 as const;

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
  requestKey?: string;
};

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
  availableAt: number;
};

export type Notification = {
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
  notify(notification: Notification): Promise<NotifyResult>;
}

/** Synchronous local transactions; no host/network call runs inside one. */
export interface MessageStore {
  /** Immutable binding; conflicting IDs, aliases or session targets throw. */
  register(peer: Peer): Peer;
  getPeer(namespace: string, id: string): Peer | null;
  findPeer(namespace: string, name: string): Peer | null;
  listPeers(namespace: string): Peer[];
  setPresence(namespace: string, id: string, presence: Presence, now: number): void;
  /** Lookup before reply validation; mismatch throws conflict, absent returns null. */
  lookupReceipt(namespace: string, senderId: string, requestKey: string, fingerprint: string): Receipt | null;
  /** Message + request-key receipt + outbox job commit atomically. */
  enqueue(input: EnqueueInput): Receipt;
  getMessage(namespace: string, id: string): Envelope | null;
  read(namespace: string, peerId: string, limit?: number): Envelope[];
  ack(namespace: string, peerId: string, ids: string[], now: number): number;
  unread(namespace: string, peerId: string): number;
  claimNotifications(input: { now: number; workerId: string; leaseMs: number; limit: number }): NotificationJob[];
  completeNotification(id: string, workerId: string): boolean;
  retryNotification(input: { id: string; workerId: string; availableAt: number; error: string; maxAttempts: number }): boolean;
  /** Remove only acknowledged messages older than before; preserve receipts. */
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
