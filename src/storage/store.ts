import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { DEFAULT_IDEMPOTENCY_MS, DEFAULT_REFERENCE_MS, MessageError, PROTOCOL_VERSION, type EnqueueInput, type Endpoint, type Envelope, type MessageReference, type MessageStore, type NotificationJob, type NotificationStatus, type Peer, type Receipt } from "../messages/contracts";
import { APPLICATION_ID, SCHEMA_VERSION } from "./paths";
import { ensureMessageDatabase } from "./initialize";
import { DIAG, safeDiagnosis } from "./diagnostics";

const SCHEMA = [
  `CREATE TABLE peers (
    namespace TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, alias TEXT NOT NULL,
    host TEXT NOT NULL, session_id TEXT NOT NULL, target TEXT NOT NULL, endpoint TEXT NOT NULL,
    presence TEXT NOT NULL, registered_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(namespace,id), UNIQUE(namespace,alias), UNIQUE(namespace,host,session_id)
  )`,
  `CREATE UNIQUE INDEX peer_targets ON peers(namespace,host,target) WHERE target <> '{}'`,
  `CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, id TEXT NOT NULL,
    sender TEXT NOT NULL, recipient TEXT NOT NULL, created_at INTEGER NOT NULL,
    envelope TEXT NOT NULL, acknowledged_at INTEGER,
    UNIQUE(namespace,id), FOREIGN KEY(namespace,sender) REFERENCES peers(namespace,id),
    FOREIGN KEY(namespace,recipient) REFERENCES peers(namespace,id)
  )`,
  `CREATE INDEX mailbox ON messages(namespace,recipient,acknowledged_at,seq)`,
  `CREATE TABLE receipts (
    namespace TEXT NOT NULL, sender TEXT NOT NULL, request_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(namespace,sender,request_key)
  )`,
  `CREATE TABLE message_references (
    namespace TEXT NOT NULL, id TEXT NOT NULL, reference TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY(namespace,id)
  )`,
  `CREATE TABLE notification_jobs (
    id TEXT PRIMARY KEY, namespace TEXT NOT NULL, peer_id TEXT NOT NULL,
    endpoint TEXT NOT NULL, generation INTEGER NOT NULL, message_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'queued',
    available_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    worker_id TEXT, lease_until INTEGER, last_error TEXT, terminal_at INTEGER
  )`,
  `CREATE INDEX dispatch_ready ON notification_jobs(status,available_at,lease_until)`,
  `CREATE UNIQUE INDEX notification_slots ON notification_jobs(namespace,peer_id,generation,phase) WHERE status='pending'`
];
type Row = Record<string, any>;
const error = (code: ConstructorParameters<typeof MessageError>[0], detail: string): never => { throw new MessageError(code, detail); };
function text(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) error("invalid", `Invalid ${label}`);
}
function integer(value: number, label: string, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) error("invalid", `Invalid ${label}`);
}
function canonicalTarget(endpoint: Endpoint) {
  text(endpoint.host, "host"); text(endpoint.sessionId, "session ID"); integer(endpoint.generation, "endpoint generation");
  if (!endpoint.target || typeof endpoint.target !== "object" || Array.isArray(endpoint.target)) error("invalid", "Invalid endpoint target");
  const entries = Object.entries(endpoint.target).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, value] of entries) { text(key, "target key"); text(value, "target value"); }
  if (endpoint.host === "t3" && (!Object.hasOwn(endpoint.target, "threadId") || endpoint.target.threadId !== endpoint.sessionId)) error("invalid", "T3 target must match its session ID");
  return JSON.stringify(Object.fromEntries(entries));
}
function endpointJson(endpoint: Endpoint) {
  return JSON.stringify({ host: endpoint.host, sessionId: endpoint.sessionId, generation: endpoint.generation, target: JSON.parse(canonicalTarget(endpoint)) });
}
function decodePeer(row: Row): Peer {
  return { id: row.id, namespace: row.namespace, name: row.name, endpoint: JSON.parse(row.endpoint), presence: row.presence,
    registeredAt: row.registered_at, lastSeenAt: row.last_seen_at };
}
function guarded<T>(fn: () => T): T {
  try { return fn(); }
  catch (cause) {
    if (cause instanceof MessageError) throw cause;
    throw new MessageError("storage", `Message storage failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export function createMessageStore({ path, now = Date.now, idempotencyMs = DEFAULT_IDEMPOTENCY_MS, referenceMs = DEFAULT_REFERENCE_MS }: {
  path: string; now?: () => number; idempotencyMs?: number; referenceMs?: number;
}): MessageStore {
  return guarded(() => {
    for (const horizon of [idempotencyMs, referenceMs]) {
      integer(horizon, "metadata lifetime", 1);
      if (horizon > 365 * 24 * 60 * 60 * 1000) error("invalid", "Metadata lifetime exceeds one year");
    }
    const readyPath = ensureMessageDatabase(path, temporaryPath => {
      const initial = new Database(temporaryPath, { create: false, strict: true });
      try {
        initial.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL");
        initial.transaction(() => {
          initial.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
          for (const sql of SCHEMA) initial.exec(sql);
        }).immediate();
        initial.exec("PRAGMA journal_mode=WAL; PRAGMA wal_checkpoint(TRUNCATE)");
      } finally { initial.close(true); } // Finalize before moving this inode to its public name.
    });
    const db = new Database(readyPath, { create: false, strict: true });
    try {
      db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
      const app = db.query("PRAGMA application_id").get() as Row;
      const version = db.query("PRAGMA user_version").get() as Row;
      const actual = db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[];
      const expected = [...SCHEMA].sort((a,b) => a.match(/(?:TABLE|INDEX) (\w+)/)![1].localeCompare(b.match(/(?:TABLE|INDEX) (\w+)/)![1]));
      if (app.application_id !== APPLICATION_ID || version.user_version !== SCHEMA_VERSION || actual.length !== expected.length
        || actual.some((row, index) => row.sql !== expected[index])) error("storage", "Unknown message database schema");
      const mode = db.query("PRAGMA journal_mode=WAL").get() as Row;
      if (mode.journal_mode !== "wal") error("storage", "Message database requires local WAL");
    } catch (cause) { db.close(true); throw cause; }

    const tx = <T>(fn: () => T): T => guarded(() => db.transaction(fn).immediate());
    const peerRow = (namespace: string, id: string) => db.query("SELECT * FROM peers WHERE namespace=? AND id=?").get(namespace, id) as Row | null;
    const requirePeer = (namespace: string, id: string) => {
      text(namespace, "namespace"); text(id, "peer ID");
      const row = peerRow(namespace, id); if (!row) return error("unknown_peer", `Unknown peer ${namespace}/${id}`); return row;
    };
    const clock = () => { const value = now(); integer(value, "store time"); return value; };
    const queue = (namespace: string, peerId: string, endpoint: string, messageId: string, time: number) => {
      const generation = (JSON.parse(endpoint) as Endpoint).generation;
      const existing = db.query("SELECT id FROM notification_jobs WHERE namespace=? AND peer_id=? AND generation=? AND status='pending' AND phase='queued'").get(namespace, peerId, generation);
      if (!existing) db.query("INSERT INTO notification_jobs(id,namespace,peer_id,endpoint,generation,message_id,available_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), namespace, peerId, endpoint, generation, messageId, time);
    };
    const reference = (m: Envelope): MessageReference => ({ id: m.id, namespace: m.namespace, from: m.from, to: m.to, conversationId: m.conversationId, createdAt: m.createdAt });
    const store: MessageStore = {
      register(peer) { return tx(() => {
        text(peer.namespace, "namespace"); text(peer.id, "peer ID"); text(peer.name, "peer name");
        integer(peer.registeredAt, "registration time"); integer(peer.lastSeenAt, "presence time");
        if (!["online", "busy", "idle", "offline"].includes(peer.presence)) error("invalid", "Invalid presence");
        const endpoint = endpointJson(peer.endpoint); const alias = peer.name.toLowerCase();
        const existing = peerRow(peer.namespace, peer.id);
        if (existing) {
          if (existing.name !== peer.name || existing.endpoint !== endpoint) error("conflict", "Peer binding conflict");
          return decodePeer(existing);
        }
        const target = canonicalTarget(peer.endpoint);
        const conflict = db.query("SELECT id FROM peers WHERE namespace=? AND (alias=? OR (host=? AND session_id=?) OR (host=? AND target=? AND target<>'{}'))").get(peer.namespace, alias, peer.endpoint.host, peer.endpoint.sessionId, peer.endpoint.host, target);
        if (conflict) error("conflict", "Peer alias or session conflict");
        db.query("INSERT INTO peers VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(peer.namespace, peer.id, peer.name, alias, peer.endpoint.host, peer.endpoint.sessionId, target, endpoint, peer.presence, peer.registeredAt, peer.lastSeenAt);
        return decodePeer(peerRow(peer.namespace, peer.id)!);
      }); },
      rebindPeer(namespace, id, expectedGeneration, endpoint, time) { return tx(() => {
        const current = requirePeer(namespace, id); integer(expectedGeneration, "expected generation"); integer(time, "rebind time");
        const encoded = endpointJson(endpoint); const target = canonicalTarget(endpoint);
        if ((JSON.parse(current.endpoint) as Endpoint).generation !== expectedGeneration || endpoint.generation !== expectedGeneration + 1) error("conflict", "Peer generation conflict");
        const conflict = db.query("SELECT id FROM peers WHERE namespace=? AND id<>? AND host=? AND (session_id=? OR (target=? AND target<>'{}'))").get(namespace, id, endpoint.host, endpoint.sessionId, target);
        if (conflict) error("conflict", "Peer session conflict");
        db.query("UPDATE peers SET host=?,session_id=?,target=?,endpoint=?,last_seen_at=? WHERE namespace=? AND id=?").run(endpoint.host, endpoint.sessionId, target, encoded, time, namespace, id);
        db.query("UPDATE notification_jobs SET status='superseded',terminal_at=?,worker_id=NULL,lease_until=NULL,last_error=? WHERE namespace=? AND peer_id=? AND status='pending'").run(time, DIAG.superseded, namespace, id);
        const unread = db.query("SELECT id FROM messages WHERE namespace=? AND recipient=? AND acknowledged_at IS NULL ORDER BY seq LIMIT 1").get(namespace, id) as Row | null;
        if (unread) queue(namespace, id, encoded, unread.id, time);
        return decodePeer(peerRow(namespace, id)!);
      }); },
      getPeer(namespace, id) { return guarded(() => { const row = peerRow(namespace, id); return row ? decodePeer(row) : null; }); },
      findPeer(namespace, name) { return guarded(() => {
        const row = db.query("SELECT * FROM peers WHERE namespace=? AND alias=?").get(namespace, name.toLowerCase()) as Row | null;
        return row ? decodePeer(row) : null;
      }); },
      listPeers(namespace) { return guarded(() => (db.query("SELECT * FROM peers WHERE namespace=? ORDER BY registered_at,id").all(namespace) as Row[]).map(decodePeer)); },
      setPresence(namespace, id, presence, time) { tx(() => {
        requirePeer(namespace, id); integer(time, "presence time");
        if (!["online", "busy", "idle", "offline"].includes(presence)) error("invalid", "Invalid presence");
        db.query("UPDATE peers SET presence=?,last_seen_at=? WHERE namespace=? AND id=?").run(presence, time, namespace, id);
      }); },
      lookupReceipt(namespace, senderId, requestKey, fingerprint) { return guarded(() => {
        text(namespace, "namespace"); text(senderId, "sender"); text(requestKey, "request key"); text(fingerprint, "fingerprint");
        const prior = db.query("SELECT * FROM receipts WHERE namespace=? AND sender=? AND request_key=?").get(namespace, senderId, requestKey) as Row | null;
        if (!prior || prior.expires_at <= clock()) return null;
        if (prior.fingerprint !== fingerprint) return error("conflict", "Request key payload conflict");
        return { id: prior.message_id, state: "stored", duplicate: true, createdAt: prior.created_at, expiresAt: prior.expires_at, requestKey };
      }); },
      enqueue(input: EnqueueInput): Receipt { return tx(() => {
        const { message: m, requestKey, fingerprint, maxPending, maxBodyBytes } = input;
        text(m.namespace, "namespace"); text(m.from, "sender"); text(m.to, "recipient"); text(fingerprint, "fingerprint");
        if (requestKey !== undefined) {
          const prior = store.lookupReceipt(m.namespace, m.from, requestKey, fingerprint);
          if (prior) return prior;
        }
        const time = clock(); const expiresAt = time + idempotencyMs;
        integer(expiresAt, "receipt expiry"); integer(time + referenceMs, "reference expiry");
        requirePeer(m.namespace, m.from); const recipient = requirePeer(m.namespace, m.to);
        text(m.id, "message ID"); text(m.conversationId, "conversation ID"); integer(m.createdAt, "creation time");
        if (m.version !== PROTOCOL_VERSION || typeof m.body !== "string") error("invalid", "Invalid message envelope");
        integer(maxPending, "queue limit"); integer(maxBodyBytes, "body limit");
        if (Buffer.byteLength(m.body, "utf8") > maxBodyBytes) error("too_large", "Message body exceeds limit");
        if (store.unread(m.namespace, m.to) >= maxPending) error("queue_full", "Mailbox queue is full");
        if (store.getMessage(m.namespace, m.id) || store.getMessageReference(m.namespace, m.id)) error("conflict", "Message ID conflict");
        db.query("INSERT INTO messages(namespace,id,sender,recipient,created_at,envelope) VALUES (?,?,?,?,?,?)").run(m.namespace, m.id, m.from, m.to, m.createdAt, JSON.stringify(m));
        db.query("INSERT OR REPLACE INTO message_references VALUES (?,?,?,?)").run(m.namespace, m.id, JSON.stringify(reference(m)), time + referenceMs);
        if (requestKey !== undefined) {
          db.query("DELETE FROM receipts WHERE namespace=? AND sender=? AND request_key=? AND expires_at<=?").run(m.namespace, m.from, requestKey, time);
          db.query("INSERT INTO receipts VALUES (?,?,?,?,?,?,?)").run(m.namespace, m.from, requestKey, fingerprint, m.id, m.createdAt, expiresAt);
        }
        queue(m.namespace, m.to, recipient.endpoint, m.id, time);
        return { id: m.id, state: "stored", duplicate: false, createdAt: m.createdAt, expiresAt, ...(requestKey !== undefined ? { requestKey } : {}) };
      }); },
      getMessage(namespace, id) { return guarded(() => {
        const row = db.query("SELECT envelope FROM messages WHERE namespace=? AND id=?").get(namespace, id) as Row | null;
        return row ? JSON.parse(row.envelope) as Envelope : null;
      }); },
      getMessageReference(namespace, id) { return guarded(() => {
        const live = store.getMessage(namespace, id); if (live) return reference(live);
        const row = db.query("SELECT reference FROM message_references WHERE namespace=? AND id=? AND expires_at>?").get(namespace, id, clock()) as Row | null;
        return row ? JSON.parse(row.reference) as MessageReference : null;
      }); },
      read(namespace, peerId, limit = 1000) { return guarded(() => {
        requirePeer(namespace, peerId); integer(limit, "read limit");
        return (db.query("SELECT envelope FROM messages WHERE namespace=? AND recipient=? AND acknowledged_at IS NULL ORDER BY seq LIMIT ?").all(namespace, peerId, limit) as Row[]).map(row => JSON.parse(row.envelope) as Envelope);
      }); },
      ack(namespace, peerId, ids, time) { return tx(() => {
        requirePeer(namespace, peerId); integer(time, "acknowledgement time"); let count = 0;
        for (const id of new Set(ids)) count += db.query("UPDATE messages SET acknowledged_at=? WHERE namespace=? AND recipient=? AND id=? AND acknowledged_at IS NULL").run(time, namespace, peerId, id).changes;
        return count;
      }); },
      unread(namespace, peerId) { return guarded(() => {
        requirePeer(namespace, peerId);
        return (db.query("SELECT count(*) AS count FROM messages WHERE namespace=? AND recipient=? AND acknowledged_at IS NULL").get(namespace, peerId) as Row).count as number;
      }); },
      claimNotifications({ now: time, workerId, leaseMs, limit }): NotificationJob[] { return tx(() => {
        text(workerId, "worker ID"); integer(time, "claim time"); integer(leaseMs, "lease duration", 1); integer(limit, "claim limit");
        integer(time + leaseMs, "lease expiry");
        const rows = db.query(`SELECT j.* FROM notification_jobs j WHERE j.status='pending' AND j.available_at<=?
          AND ((j.phase='claimed' AND j.lease_until<=?) OR (j.phase='queued' AND NOT EXISTS
            (SELECT 1 FROM notification_jobs c WHERE c.namespace=j.namespace AND c.peer_id=j.peer_id AND c.generation=j.generation AND c.phase='claimed' AND c.status='pending')))
          ORDER BY j.available_at,j.rowid LIMIT ?`).all(time, time, limit) as Row[];
        for (const row of rows) db.query("UPDATE notification_jobs SET phase='claimed',worker_id=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(workerId, time + leaseMs, row.id);
        return rows.map(row => ({ id: row.id, namespace: row.namespace, peerId: row.peer_id, endpoint: JSON.parse(row.endpoint), messageId: row.message_id, attempts: row.attempts + 1, failures: row.failures, availableAt: row.available_at }));
      }); },
      completeNotification(id, workerId, state = "sent") { return guarded(() => {
        if (state !== "sent" && state !== "empty") error("invalid", "Invalid completion state");
        const time = clock();
        return db.query("UPDATE notification_jobs SET status=?,terminal_at=?,worker_id=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND worker_id=? AND status='pending' AND lease_until>?").run(state, time, id, workerId, time).changes === 1;
      }); },
      failNotification(id, workerId, detail, state = "failed") { return guarded(() => {
        if (!["failed", "unsupported", "superseded"].includes(state)) error("invalid", "Invalid failure state");
        const time = clock();
        return db.query("UPDATE notification_jobs SET status=?,terminal_at=?,last_error=?,failures=failures+?,worker_id=NULL,lease_until=NULL WHERE id=? AND worker_id=? AND status='pending' AND lease_until>?").run(state, time, safeDiagnosis(detail), state === "failed" ? 1 : 0, id, workerId, time).changes === 1;
      }); },
      retryNotification({ id, workerId, availableAt, error: detail, maxAttempts, countFailure = true }) { return guarded(() => {
        integer(availableAt, "retry time"); integer(maxAttempts, "attempt limit", 1);
        if (typeof countFailure !== "boolean") error("invalid", "Invalid failure count option");
        const time = clock(); const add = countFailure ? 1 : 0;
        return db.query(`UPDATE notification_jobs SET status=CASE WHEN ?=1 AND failures+1>=? THEN 'failed' ELSE 'pending' END,
          terminal_at=CASE WHEN ?=1 AND failures+1>=? THEN ? ELSE NULL END,failures=failures+?,available_at=?,last_error=?,worker_id=NULL,lease_until=0
          WHERE id=? AND worker_id=? AND status='pending' AND lease_until>?`).run(add, maxAttempts, add, maxAttempts, time, add, availableAt, safeDiagnosis(detail), id, workerId, time).changes === 1;
      }); },
      notificationStatus(namespace, peerId) { return guarded(() => {
        text(namespace, "namespace"); if (peerId !== undefined) text(peerId, "peer ID");
        const rows = (peerId === undefined ? db.query("SELECT * FROM notification_jobs WHERE namespace=? ORDER BY rowid").all(namespace)
          : db.query("SELECT * FROM notification_jobs WHERE namespace=? AND peer_id=? ORDER BY rowid").all(namespace, peerId)) as Row[];
        return rows.map((row): NotificationStatus => ({ id: row.id, namespace: row.namespace, peerId: row.peer_id, state: row.status,
          attempts: row.attempts, failures: row.failures, availableAt: row.available_at,
          ...(row.worker_id !== null ? { leaseUntil: row.lease_until } : {}), ...(row.last_error !== null ? { detail: safeDiagnosis(row.last_error) } : {}) }));
      }); },
      prune(before) { return tx(() => {
        integer(before, "retention cutoff");
        const time = clock();
        db.query("DELETE FROM receipts WHERE expires_at<=?").run(time);
        db.query("DELETE FROM message_references WHERE expires_at<=?").run(time);
        db.query("DELETE FROM notification_jobs WHERE status<>'pending' AND terminal_at<?").run(before);
        return db.query("DELETE FROM messages WHERE acknowledged_at IS NOT NULL AND acknowledged_at<?").run(before).changes;
      }); },
      close() { db.close(true); }
    };
    return store;
  });
}
