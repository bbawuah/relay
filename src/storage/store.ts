import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { MessageError, PROTOCOL_VERSION, type EnqueueInput, type Endpoint, type Envelope, type MessageStore, type NotificationJob, type Peer, type Presence, type Receipt } from "../messages/contracts";
import { APPLICATION_ID, preparePath, SCHEMA_VERSION } from "./paths";

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
    fingerprint TEXT NOT NULL, message_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(namespace,sender,request_key)
  )`,
  `CREATE TABLE notification_jobs (
    id TEXT PRIMARY KEY, namespace TEXT NOT NULL, peer_id TEXT NOT NULL,
    endpoint TEXT NOT NULL, message_id TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    worker_id TEXT, lease_until INTEGER, last_error TEXT
  )`,
  `CREATE INDEX dispatch_ready ON notification_jobs(status,available_at,lease_until)`
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

export function createMessageStore({ path, now = Date.now }: { path: string; now?: () => number }): MessageStore {
  return guarded(() => {
    const prepared = preparePath(path);
    const db = new Database(prepared.path, { create: false, strict: true });
    try {
      db.exec("PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL");
      if (prepared.fresh) {
        db.transaction(() => {
          db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${SCHEMA_VERSION}`);
          for (const sql of SCHEMA) db.exec(sql);
        }).immediate();
      } else {
        const app = db.query("PRAGMA application_id").get() as Row;
        const version = db.query("PRAGMA user_version").get() as Row;
        const actual = db.query("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[];
        const expected = [...SCHEMA].sort((a,b) => a.match(/(?:TABLE|INDEX) (\w+)/)![1].localeCompare(b.match(/(?:TABLE|INDEX) (\w+)/)![1]));
        if (app.application_id !== APPLICATION_ID || version.user_version !== SCHEMA_VERSION || actual.length !== expected.length
          || actual.some((row, index) => row.sql !== expected[index])) error("storage", "Unknown message database schema");
      }
      const mode = db.query("PRAGMA journal_mode=WAL").get() as Row;
      if (mode.journal_mode !== "wal") error("storage", "Message database requires local WAL");
    } catch (cause) { db.close(); throw cause; }

    const tx = <T>(fn: () => T): T => guarded(() => db.transaction(fn).immediate());
    const peerRow = (namespace: string, id: string) => db.query("SELECT * FROM peers WHERE namespace=? AND id=?").get(namespace, id) as Row | null;
    const requirePeer = (namespace: string, id: string) => {
      text(namespace, "namespace"); text(id, "peer ID");
      const row = peerRow(namespace, id); if (!row) return error("unknown_peer", `Unknown peer ${namespace}/${id}`); return row;
    };
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
        if (!prior) return null;
        if (prior.fingerprint !== fingerprint) return error("conflict", "Request key payload conflict");
        return { id: prior.message_id, state: "stored", duplicate: true, createdAt: prior.created_at, requestKey };
      }); },
      enqueue(input: EnqueueInput): Receipt { return tx(() => {
        const { message: m, requestKey, fingerprint, maxPending, maxBodyBytes } = input;
        text(m.namespace, "namespace"); text(m.from, "sender"); text(m.to, "recipient"); text(fingerprint, "fingerprint");
        if (requestKey !== undefined) {
          const prior = store.lookupReceipt(m.namespace, m.from, requestKey, fingerprint);
          if (prior) return prior;
        }
        requirePeer(m.namespace, m.from); const recipient = requirePeer(m.namespace, m.to);
        text(m.id, "message ID"); text(m.conversationId, "conversation ID"); integer(m.createdAt, "creation time");
        if (m.version !== PROTOCOL_VERSION || typeof m.body !== "string") error("invalid", "Invalid message envelope");
        integer(maxPending, "queue limit"); integer(maxBodyBytes, "body limit");
        if (Buffer.byteLength(m.body, "utf8") > maxBodyBytes) error("too_large", "Message body exceeds limit");
        if (store.unread(m.namespace, m.to) >= maxPending) error("queue_full", "Mailbox queue is full");
        if (store.getMessage(m.namespace, m.id)) error("conflict", "Message ID conflict");
        db.query("INSERT INTO messages(namespace,id,sender,recipient,created_at,envelope) VALUES (?,?,?,?,?,?)").run(m.namespace, m.id, m.from, m.to, m.createdAt, JSON.stringify(m));
        if (requestKey !== undefined) db.query("INSERT INTO receipts VALUES (?,?,?,?,?,?)").run(m.namespace, m.from, requestKey, fingerprint, m.id, m.createdAt);
        db.query("INSERT INTO notification_jobs(id,namespace,peer_id,endpoint,message_id,available_at) VALUES (?,?,?,?,?,?)").run(randomUUID(), m.namespace, m.to, recipient.endpoint, m.id, now());
        return { id: m.id, state: "stored", duplicate: false, createdAt: m.createdAt, ...(requestKey !== undefined ? { requestKey } : {}) };
      }); },
      getMessage(namespace, id) { return guarded(() => {
        const row = db.query("SELECT envelope FROM messages WHERE namespace=? AND id=?").get(namespace, id) as Row | null;
        return row ? JSON.parse(row.envelope) as Envelope : null;
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
        const rows = db.query("SELECT * FROM notification_jobs WHERE status='pending' AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY available_at,rowid LIMIT ?").all(time, time, limit) as Row[];
        for (const row of rows) db.query("UPDATE notification_jobs SET worker_id=?,lease_until=?,attempts=attempts+1 WHERE id=?").run(workerId, time + leaseMs, row.id);
        return rows.map(row => ({ id: row.id, namespace: row.namespace, peerId: row.peer_id, endpoint: JSON.parse(row.endpoint), messageId: row.message_id, attempts: row.attempts + 1, availableAt: row.available_at }));
      }); },
      completeNotification(id, workerId) { return guarded(() => db.query("UPDATE notification_jobs SET status='sent',worker_id=NULL,lease_until=NULL,last_error=NULL WHERE id=? AND worker_id=? AND status='pending' AND lease_until>?").run(id, workerId, now()).changes === 1); },
      retryNotification({ id, workerId, availableAt, error: detail, maxAttempts }) { return guarded(() => {
        integer(availableAt, "retry time"); integer(maxAttempts, "attempt limit", 1);
        return db.query("UPDATE notification_jobs SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'pending' END,available_at=?,last_error=?,worker_id=NULL,lease_until=NULL WHERE id=? AND worker_id=? AND status='pending' AND lease_until>?").run(maxAttempts, availableAt, detail, id, workerId, now()).changes === 1;
      }); },
      prune(before) { return tx(() => {
        integer(before, "retention cutoff");
        // Keep jobs/diagnoses and caller receipts independently of envelope retention.
        return db.query("DELETE FROM messages WHERE acknowledged_at IS NOT NULL AND acknowledged_at<?").run(before).changes;
      }); },
      close() { db.close(); }
    };
    return store;
  });
}
