import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createDirectory } from "../src/directory";
import { createMessageService } from "../src/messages/service";
import { DEFAULT_IDEMPOTENCY_MS, DEFAULT_REFERENCE_MS, MessageError, type MessageErrorCode, type EnqueueInput, type Envelope, type MessageReference, type MessageStore, type Peer, type Receipt, type SendRequest } from "../src/messages/contracts";

// A disposable transactional model of the seam, not evidence about SQLite or hosts.
function memoryStore(clock: () => number, { idempotencyMs = DEFAULT_IDEMPOTENCY_MS, referenceMs = DEFAULT_REFERENCE_MS }: { idempotencyMs?: number; referenceMs?: number } = {}) {
  const peers: Peer[] = [];
  const messages: Envelope[] = [];
  const acknowledged = new Set<string>();
  const receipts = new Map<string, { fingerprint: string; receipt: Receipt }>();
  const references = new Map<string, { reference: MessageReference; expiresAt: number }>();
  const enqueued: EnqueueInput[] = [];
  let failNextWrite = false;
  const key = (...parts: string[]) => JSON.stringify(parts);
  const unused = (): never => { throw new Error("notification operation outside core test"); };
  const store: MessageStore = {
    register(peer) { peers.push(structuredClone(peer)); return structuredClone(peer); },
    rebindPeer: unused,
    getPeer(ns, id) { return peers.find((p) => p.namespace === ns && p.id === id) ?? null; },
    findPeer(ns, name) { return peers.find((p) => p.namespace === ns && p.name.toLowerCase() === name.toLowerCase()) ?? null; },
    listPeers(ns) { return peers.filter((p) => p.namespace === ns); },
    setPresence(ns, id, presence, now) {
      const peer = store.getPeer(ns, id);
      if (!peer) throw new MessageError("unknown_peer", "unknown peer");
      peer.presence = presence; peer.lastSeenAt = now;
    },
    lookupReceipt(ns, sender, requestKey, fingerprint) {
      const previous = receipts.get(key(ns, sender, requestKey));
      if (!previous || previous.receipt.expiresAt <= clock()) return null;
      if (previous.fingerprint !== fingerprint) throw new MessageError("conflict", "request key changed payload");
      return { ...previous.receipt, duplicate: true };
    },
    enqueue(input) {
      const { message, requestKey, fingerprint } = input;
      if (requestKey !== undefined) {
        const previous = store.lookupReceipt(message.namespace, message.from, requestKey, fingerprint);
        if (previous) return previous;
      }
      if (failNextWrite) { failNextWrite = false; throw new MessageError("storage", "simulated disk full before commit"); }
      if (store.unread(message.namespace, message.to) >= input.maxPending) throw new MessageError("queue_full", "mailbox full");
      if (Buffer.byteLength(message.body, "utf8") > input.maxBodyBytes) throw new MessageError("too_large", "body too large");
      if (store.getMessage(message.namespace, message.id)) throw new MessageError("conflict", "duplicate message id");
      const receipt: Receipt = { id: message.id, state: "stored", duplicate: false, createdAt: message.createdAt, expiresAt: clock() + idempotencyMs, ...(requestKey === undefined ? {} : { requestKey }) };
      messages.push(structuredClone(message)); enqueued.push(structuredClone(input));
      if (requestKey !== undefined) receipts.set(key(message.namespace, message.from, requestKey), { fingerprint, receipt });
      const { body: _body, replyTo: _replyTo, version: _version, ...reference } = message;
      references.set(key(message.namespace, message.id), { reference, expiresAt: clock() + referenceMs });
      return receipt;
    },
    getMessage(ns, id) { return messages.find((m) => m.namespace === ns && m.id === id) ?? null; },
    getMessageReference(ns, id) {
      const body = store.getMessage(ns, id);
      if (body) {
        const { body: _body, replyTo: _replyTo, version: _version, ...reference } = body;
        return reference;
      }
      const retained = references.get(key(ns, id));
      return retained && retained.expiresAt > clock() ? retained.reference : null;
    },
    read(ns, peerId, limit) { return messages.filter((m) => m.namespace === ns && m.to === peerId && !acknowledged.has(key(ns, peerId, m.id))).slice(0, limit); },
    ack(ns, peerId, ids) {
      let count = 0;
      for (const id of ids) {
        const message = store.getMessage(ns, id);
        const ackKey = key(ns, peerId, id);
        if (message?.to === peerId && !acknowledged.has(ackKey)) { acknowledged.add(ackKey); count++; }
      }
      return count;
    },
    unread(ns, peerId) { return store.read(ns, peerId).length; },
    prune(before) {
      let count = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]!;
        if (m.createdAt < before && acknowledged.has(key(m.namespace, m.to, m.id))) { messages.splice(i, 1); count++; }
      }
      for (const [key, saved] of references) if (saved.expiresAt <= clock()) references.delete(key);
      for (const [key, saved] of receipts) if (saved.receipt.expiresAt <= clock()) receipts.delete(key);
      return count;
    },
    claimNotifications: unused, completeNotification: unused, failNotification: unused, retryNotification: unused, notificationStatus: unused,
    close() {},
  };
  return { store, peers, messages, enqueued, failNextWrite() { failNextWrite = true; } };
}

function fixture({ idempotencyMs, referenceMs, ...options }: { maxPending?: number; maxBodyBytes?: number; idempotencyMs?: number; referenceMs?: number } = {}) {
  let timestamp = 100;
  const memory = memoryStore(() => timestamp, { idempotencyMs, referenceMs });
  let sequence = 0;
  const directory = createDirectory({ store: memory.store, now: () => timestamp, id: () => `peer-${++sequence}` });
  for (const namespace of ["project", "elsewhere"]) {
    for (const name of ["Alice", "Bob", "Carol"]) directory.register({ namespace, name, peerId: name.toLowerCase(), endpoint: { host: "manual", sessionId: name.toLowerCase(), generation: 1, target: {} } });
  }
  const service = createMessageService({ store: memory.store, now: () => timestamp++, id: () => `message-${++sequence}`, ...options });
  const request: SendRequest = { namespace: "project", from: "ALICE", to: "BOB", body: "hello" };
  return { ...memory, service, directory, request, time: () => timestamp, advance(ms: number) { timestamp += ms; } };
}

function errorCode(action: () => unknown, code: MessageErrorCode) {
  try { action(); } catch (error) { expect(error).toBeInstanceOf(MessageError); expect((error as MessageError).code).toBe(code); return error as MessageError; }
  throw new Error(`expected ${code}`);
}

describe("message service", () => {
  test("offline mailboxes exchange labelled data, repeated reads preserve order and ack is recipient scoped", () => {
    const { service, store, request } = fixture();
    const first = service.send({ ...request, body: "<message>quoted text, any content</message>" });
    const second = service.send(request);
    const inbox = service.read({ namespace: "project", peerId: "bOb", limit: 1 });
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ version: 2, id: first.id, from: "alice", to: "bob", body: "<message>quoted text, any content</message>" });
    expect(service.read({ namespace: "project", peerId: "bob" }).map((m) => m.id)).toEqual([first.id, second.id]);
    expect(service.read({ namespace: "project", peerId: "bob" })).toHaveLength(2);
    expect(service.ack({ namespace: "project", peerId: "alice", ids: [first.id] })).toBe(0);
    expect(service.ack({ namespace: "elsewhere", peerId: "bob", ids: [first.id] })).toBe(0);
    expect(service.ack({ namespace: "project", peerId: "BOB", ids: [first.id, first.id, "missing"] })).toBe(1);
    expect(service.ack({ namespace: "project", peerId: "bob", ids: [first.id] })).toBe(0);
    expect(store.getMessage("project", first.id)).not.toBeNull();
    expect(service.read({ namespace: "project", peerId: "bob" }).map((m) => m.id)).toEqual([second.id]);
    expect(service.list("project").map((p) => [p.name, p.presence])).toEqual([["Alice", "offline"], ["Bob", "offline"], ["Carol", "offline"]]);
  });

  test("canonical caller payload survives generated IDs/time and alias spelling on retries", () => {
    const { service, request, enqueued } = fixture();
    const original = service.send({ ...request, requestKey: "retry-1" });
    const retried = service.send({ ...request, from: "alice", to: "bob", requestKey: "retry-1" });
    expect(retried).toEqual({ ...original, duplicate: true });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const second = service.send({ ...request, requestKey: "retry-2" });
    expect(second.id).not.toBe(original.id);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]!.fingerprint).toBe(enqueued[1]!.fingerprint);
    expect(enqueued[0]!.maxPending).toBe(1000);
    expect(enqueued[0]!.maxBodyBytes).toBe(16000);
  });

  test("a failed commit reserves no success; identical retry stores once", () => {
    const { service, request, failNextWrite, enqueued } = fixture();
    failNextWrite();
    errorCode(() => service.send({ ...request, requestKey: "disk-recovery" }), "storage");
    expect(service.read({ namespace: "project", peerId: "bob" })).toEqual([]);
    const receipt = service.send({ ...request, requestKey: "disk-recovery" });
    expect(receipt).toMatchObject({ state: "stored", duplicate: false });
    expect(service.send({ ...request, requestKey: "disk-recovery" })).toEqual({ ...receipt, duplicate: true });
    expect(enqueued).toHaveLength(1);
    expect(service.read({ namespace: "project", peerId: "bob" })[0]?.id).toBe(receipt.id);
  });

  test("receipt keys are scoped to the namespace and resolved sender", () => {
    const { service, request, messages } = fixture();
    for (const change of [{}, { from: "Bob", to: "Alice" }, { namespace: "elsewhere" }]) service.send({ ...request, ...change, requestKey: "same-key" });
    expect(messages).toHaveLength(3);
  });

  test.each([{ body: "changed" }, { to: "Carol" }, { conversationId: "another-conversation" }])("key reuse with changed payload fails: %j", (change) => {
    const { service, request, messages } = fixture();
    service.send({ ...request, requestKey: "one" });
    errorCode(() => service.send({ ...request, ...change, requestKey: "one" }), "conflict");
    expect(messages).toHaveLength(1);
  });

  test("queue backpressure recovers after ack and permits duplicate retries while full", () => {
    const { service, request, messages } = fixture({ maxPending: 1 });
    const first = service.send({ ...request, requestKey: "first" });
    expect(service.send({ ...request, requestKey: "first" }).duplicate).toBe(true);
    errorCode(() => service.send({ ...request, requestKey: "second" }), "queue_full");
    expect(messages).toHaveLength(1);
    service.ack({ namespace: "project", peerId: "bob", ids: [first.id] });
    expect(service.send({ ...request, requestKey: "second" }).state).toBe("stored");
  });

  test("body limit counts UTF-8 bytes and accepts the exact default boundary", () => {
    const { service, request, messages } = fixture();
    service.send({ ...request, body: "😀".repeat(4000) });
    errorCode(() => service.send({ ...request, body: "😀".repeat(4000) + "x" }), "too_large");
    expect(messages).toHaveLength(1);
    const bounded = fixture({ maxBodyBytes: 3 });
    errorCode(() => bounded.service.send({ ...bounded.request, body: "😀" }), "too_large");
    expect(bounded.service.send({ ...bounded.request, body: "é" }).state).toBe("stored");
  });

  test("reply chains retain their conversation with no eight-reply cap", () => {
    const { service, request, store } = fixture();
    let previous = service.send(request);
    const conversationId = store.getMessage("project", previous.id)!.conversationId;
    for (let index = 0; index < 12; index++) {
      previous = service.send({ ...request, from: index % 2 ? "Alice" : "Bob", to: index % 2 ? "Bob" : "Alice", replyTo: previous.id });
      expect(store.getMessage("project", previous.id)?.conversationId).toBe(conversationId);
    }
  });

  test("missing, cross-namespace, unrelated and mismatched-conversation replies fail without writes", () => {
    const { service, request, store, messages } = fixture();
    const root = service.send(request);
    const conversationId = store.getMessage("project", root.id)!.conversationId;
    for (const change of [{ replyTo: "missing" }, { replyTo: root.id, namespace: "elsewhere" }, { replyTo: root.id, from: "Carol" }, { replyTo: root.id, conversationId: "wrong" }]) {
      errorCode(() => service.send({ ...request, ...change }), "invalid");
    }
    expect(messages).toHaveLength(1);
    expect(service.send({ ...request, from: "Bob", to: "Alice", replyTo: root.id, conversationId }).state).toBe("stored");
  });

  test("R1/R2: keyed reply receipt bypasses an expired reference; changes still conflict", () => {
    const { service, store, request, enqueued, advance } = fixture({ idempotencyMs: 1000, referenceMs: 10 });
    const original = service.send(request);
    const reply: SendRequest = { ...request, from: "Bob", to: "Alice", replyTo: original.id, requestKey: "reply" };
    const receipt = service.send(reply);
    service.ack({ namespace: "project", peerId: "Bob", ids: [original.id] });
    expect(store.prune(1000)).toBe(1);
    expect(store.getMessage("project", original.id)).toBeNull();
    advance(20);
    expect(store.getMessageReference("project", original.id)).toBeNull();
    expect(service.send(reply)).toEqual({ ...receipt, duplicate: true });
    for (const change of [{ body: "different" }, { to: "Carol" }, { replyTo: "different" }, { conversationId: "different" }]) {
      errorCode(() => service.send({ ...reply, ...change }), "conflict");
    }
    errorCode(() => service.send({ ...reply, requestKey: "new" }), "invalid");
    expect(enqueued).toHaveLength(2);
  });

  test("R2: a new reply after body pruning uses the retained participant/conversation reference", () => {
    const { service, store, request, messages } = fixture();
    const root = service.send(request);
    const conversationId = store.getMessage("project", root.id)!.conversationId;
    service.ack({ namespace: "project", peerId: "Bob", ids: [root.id] });
    expect(store.prune(1000)).toBe(1);
    expect(store.getMessage("project", root.id)).toBeNull();
    const reply = service.send({ ...request, from: "Bob", to: "Alice", replyTo: root.id, requestKey: "new-reply" });
    expect(store.getMessage("project", reply.id)).toMatchObject({ conversationId, replyTo: root.id, from: "bob", to: "alice" });
    errorCode(() => service.send({ ...request, from: "Carol", replyTo: root.id }), "invalid");
    errorCode(() => service.send({ ...request, namespace: "elsewhere", replyTo: root.id }), "invalid");
    expect(messages).toHaveLength(1);
  });

  test("R2: an expired pruned reply reference produces an explicit error and no new message", () => {
    const { service, store, request, advance, messages } = fixture({ referenceMs: 10 });
    const root = service.send(request);
    service.ack({ namespace: "project", peerId: "Bob", ids: [root.id] });
    store.prune(1000);
    advance(10);
    expect(errorCode(() => service.send({ ...request, from: "Bob", to: "Alice", replyTo: root.id }), "invalid").message).toContain("missing or expired");
    expect(messages).toHaveLength(0);
  });

  test("R2: service passes persisted receipt expiry through; an expired key starts a new send", () => {
    const { service, request, store, advance, time, enqueued } = fixture({ idempotencyMs: 10 });
    const keyed = { ...request, requestKey: "bounded-retry" };
    const receipt = service.send(keyed);
    expect(receipt.expiresAt).toBe(time() + 10);
    const retry = service.send(keyed);
    expect(retry).toEqual({ ...receipt, duplicate: true });
    errorCode(() => service.send({ ...keyed, body: "changed" }), "conflict");
    advance(receipt.expiresAt - time());
    const renewed = service.send({ ...keyed, body: "changed after expiry" });
    expect(renewed).toMatchObject({ state: "stored", duplicate: false, requestKey: keyed.requestKey });
    expect(renewed.id).not.toBe(receipt.id);
    expect(renewed.expiresAt).toBeGreaterThan(receipt.expiresAt);
    expect(store.getMessage("project", renewed.id)?.body).toBe("changed after expiry");
    expect(enqueued).toHaveLength(2);
  });

  test("enqueue still arbitrates a retry racing the preliminary receipt lookup", () => {
    const { service, store, request, enqueued } = fixture();
    const receipt = service.send({ ...request, requestKey: "race" });
    const lookup = store.lookupReceipt;
    let first = true;
    store.lookupReceipt = (...args) => { if (first) { first = false; return null; } return lookup(...args); };
    expect(service.send({ ...request, requestKey: "race" })).toEqual({ ...receipt, duplicate: true });
    expect(enqueued).toHaveLength(1);
  });

  test("missing and ambiguous identities never select another mailbox", () => {
    const { service, request, peers, messages } = fixture();
    errorCode(() => service.send({ ...request, to: "unknown" }), "unknown_peer");
    errorCode(() => service.read({ namespace: "project", peerId: "unknown" }), "unknown_peer");
    peers.push({ ...peers[2]!, id: "BOB", name: "different" });
    errorCode(() => service.send(request), "conflict");
    errorCode(() => service.ack({ namespace: "project", peerId: "BOB", ids: [] }), "conflict");
    expect(messages).toHaveLength(0);
  });

  test.each([{ namespace: "" }, { from: "" }, { to: "Bob\n" }, { body: 3 }, { requestKey: "" }, { conversationId: "" }, { replyTo: "" }])("invalid send payload is rejected before persistence: %j", (change) => {
    const { service, request, enqueued } = fixture();
    errorCode(() => service.send({ ...request, ...change } as SendRequest), "invalid");
    expect(enqueued).toHaveLength(0);
  });

  test("read and ack validate their bounds without modifying unread state", () => {
    const { service, request } = fixture();
    service.send(request);
    for (const limit of [0, -1, 1.5, NaN, Infinity]) errorCode(() => service.read({ namespace: "project", peerId: "Bob", limit }), "invalid");
    errorCode(() => service.ack({ namespace: "project", peerId: "Bob", ids: [""] }), "invalid");
    errorCode(() => service.ack({ namespace: "project", peerId: "Bob", ids: "bad" as unknown as string[] }), "invalid");
    expect(service.read({ namespace: "project", peerId: "Bob" })).toHaveLength(1);
  });

  test("new core source imports no policy, lead, Git, tmux or provider hooks", () => {
    for (const path of ["../src/messages/service.ts", "../src/directory/index.ts", "../src/directory/validation.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      const imports = [...source.matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g)].map((match) => match[1]);
      expect(imports.some((name) => /lead|beleid|policy|tmux|hooks|child_process|\/git/.test(name!))).toBe(false);
    }
  });
});
