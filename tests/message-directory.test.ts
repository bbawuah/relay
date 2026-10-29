import { expect, test } from "bun:test";
import { createDirectory, resolvePeer } from "../src/directory";
import { MessageError, type MessageErrorCode, type Endpoint, type MessageStore, type Peer } from "../src/messages/contracts";

function fixture() {
  const peers: Peer[] = [];
  let now = 50;
  let sequence = 0;
  let writes = 0;
  const rebindings: Array<{ namespace: string; id: string; expectedGeneration: number; endpoint: Endpoint; timestamp: number }> = [];
  const unused = (): never => { throw new Error("outside directory seam"); };
  const store: MessageStore = {
    register(peer) {
      writes++;
      const existing = store.getPeer(peer.namespace, peer.id);
      if (existing) {
        if (existing.name.toLowerCase() !== peer.name.toLowerCase() || JSON.stringify(existing.endpoint) !== JSON.stringify(peer.endpoint)) throw new MessageError("conflict", "binding changed");
        return structuredClone(existing);
      }
      if (store.findPeer(peer.namespace, peer.name) || peers.some((p) => p.namespace === peer.namespace && p.endpoint.host === peer.endpoint.host && p.endpoint.sessionId === peer.endpoint.sessionId)) throw new MessageError("conflict", "duplicate alias/session");
      peers.push(structuredClone(peer));
      return structuredClone(peer);
    },
    rebindPeer(namespace, id, expectedGeneration, endpoint, timestamp) {
      rebindings.push({ namespace, id, expectedGeneration, endpoint: structuredClone(endpoint), timestamp });
      const peer = store.getPeer(namespace, id);
      if (!peer) throw new MessageError("unknown_peer", "unknown peer");
      if (peer.endpoint.generation !== expectedGeneration || endpoint.generation !== expectedGeneration + 1) throw new MessageError("conflict", "stale endpoint generation");
      if (peers.some((p) => p.namespace === namespace && p.id !== id && p.endpoint.host === endpoint.host && p.endpoint.sessionId === endpoint.sessionId)) throw new MessageError("conflict", "another peer owns this host session");
      peer.endpoint = structuredClone(endpoint);
      peer.lastSeenAt = timestamp;
      return structuredClone(peer);
    },
    getPeer(ns, id) { return peers.find((p) => p.namespace === ns && p.id === id) ?? null; },
    findPeer(ns, name) { return peers.find((p) => p.namespace === ns && p.name.toLowerCase() === name.toLowerCase()) ?? null; },
    listPeers(ns) { return peers.filter((p) => p.namespace === ns); },
    setPresence(ns, id, presence, timestamp) {
      const peer = store.getPeer(ns, id);
      if (!peer) throw new MessageError("unknown_peer", "unknown peer");
      peer.presence = presence; peer.lastSeenAt = timestamp;
    },
    lookupReceipt: unused, enqueue: unused, getMessage: unused, getMessageReference: unused, read: unused, ack: unused, unread: unused,
    claimNotifications: unused, completeNotification: unused, failNotification: unused, retryNotification: unused, notificationStatus: unused, prune: unused, close() {},
  };
  const directory = createDirectory({ store, now: () => now, id: () => `peer-${++sequence}` });
  const endpoint: Endpoint = { host: "t3", sessionId: "thread-one", generation: 1, target: { threadId: "thread-one", workspace: "same-checkout" } };
  return { store, directory, endpoint, peers, rebindings, tick() { now++; }, writes: () => writes };
}

function errorCode(action: () => unknown, code: MessageErrorCode) {
  try { action(); } catch (error) { expect(error).toBeInstanceOf(MessageError); expect((error as MessageError).code).toBe(code); return; }
  throw new Error(`expected ${code}`);
}

test("explicit same-checkout sessions have distinct stable mailboxes without host inference", () => {
  const { directory, store, endpoint } = fixture();
  const first = directory.register({ namespace: "project", name: "Alice", endpoint });
  const second = directory.register({ namespace: "project", name: "Bob", endpoint: { ...endpoint, sessionId: "thread-two", target: { ...endpoint.target, threadId: "thread-two" } } });
  expect(first.id).not.toBe(second.id);
  expect(first).toMatchObject({ namespace: "project", name: "Alice", endpoint, presence: "offline", registeredAt: 50, lastSeenAt: 50 });
  expect(resolvePeer(store, "project", "ALICE").id).toBe(first.id);
  expect(resolvePeer(store, "project", second.id).id).toBe(second.id);
});

test("registration retry preserves ID, display alias, registration time and observed presence", () => {
  const { directory, endpoint, tick, store } = fixture();
  const first = directory.register({ namespace: "project", name: "Alice", endpoint });
  tick();
  directory.setPresence("project", first.id, "busy");
  const retry = directory.register({ namespace: "project", name: "aLiCe", endpoint: { ...endpoint, target: { workspace: "same-checkout", threadId: "thread-one" } } });
  expect(retry).toEqual({ ...first, presence: "busy", lastSeenAt: 51 });
  expect(store.listPeers("project")).toHaveLength(1);
});

test("aliases are case-insensitively unique within their explicit namespace", () => {
  const { directory, endpoint, store } = fixture();
  directory.register({ namespace: "project", name: "Alice", peerId: "fixed", endpoint });
  errorCode(() => directory.register({ namespace: "project", name: "ALICE", peerId: "other", endpoint: { ...endpoint, sessionId: "other", target: { threadId: "other" } } }), "conflict");
  const elsewhere = directory.register({ namespace: "other", name: "ALICE", peerId: "fixed", endpoint });
  expect(elsewhere.namespace).toBe("other");
  expect(store.listPeers("project")).toHaveLength(1);
});

test.each(["generation", "target", "host", "sessionId", "name"])("existing peer ID cannot acquire another %s binding", (field) => {
  const { directory, endpoint, store } = fixture();
  const original = directory.register({ namespace: "project", name: "Alice", peerId: "fixed", endpoint });
  const changed: Endpoint = { ...endpoint, target: { ...endpoint.target } };
  if (field === "generation") changed.generation = 2;
  if (field === "target") changed.target.workspace = "other";
  if (field === "host") changed.host = "manual";
  if (field === "sessionId") { changed.sessionId = "other"; changed.target.threadId = "other"; }
  errorCode(() => directory.register({ namespace: "project", name: field === "name" ? "different" : "Alice", peerId: "fixed", endpoint: changed }), "conflict");
  expect(store.getPeer("project", "fixed")).toEqual(original);
});

test("session references cannot be reused for another alias or peer ID", () => {
  const { directory, endpoint, store } = fixture();
  const original = directory.register({ namespace: "project", name: "Alice", endpoint });
  errorCode(() => directory.register({ namespace: "project", name: "Bob", endpoint }), "conflict");
  errorCode(() => directory.register({ namespace: "project", name: "Bob", endpoint: { ...endpoint, generation: 2, target: { ...endpoint.target, workspace: "other" } } }), "conflict");
  expect(store.listPeers("project")).toEqual([original]);
});

test("ambiguous alias/ID resolution fails rather than reading or updating the wrong mailbox", () => {
  const { directory, store, endpoint, peers } = fixture();
  const original = directory.register({ namespace: "project", name: "Alice", peerId: "first", endpoint });
  peers.push({ ...original, id: "ALICE", name: "Bob", endpoint: { ...endpoint, sessionId: "other" } });
  errorCode(() => resolvePeer(store, "project", "ALICE"), "conflict");
  errorCode(() => directory.setPresence("project", "ALICE", "online"), "conflict");
  expect(peers.every((p) => p.presence === "offline")).toBe(true);
});

test("registration rejects a new alias shadowing an ID and an ID shadowing an alias", () => {
  const { directory, endpoint, store } = fixture();
  const original = directory.register({ namespace: "project", name: "Alice", peerId: "fixed", endpoint });
  for (const identity of [{ name: "fixed", peerId: "other" }, { name: "Bob", peerId: "ALICE" }]) {
    errorCode(() => directory.register({ namespace: "project", ...identity, endpoint: { ...endpoint, sessionId: "other", target: { threadId: "other" } } }), "conflict");
  }
  expect(store.listPeers("project")).toEqual([original]);
});

test("a store uniqueness conflict after preflight is surfaced without a false registration", () => {
  const { directory, endpoint, store, peers } = fixture();
  store.register = () => { throw new MessageError("conflict", "another writer claimed the alias"); };
  errorCode(() => directory.register({ namespace: "project", name: "Alice", endpoint }), "conflict");
  expect(peers).toHaveLength(0);
});

test("presence accepts only explicit known mailboxes and updates no registration binding", () => {
  const { directory, endpoint, store, tick } = fixture();
  const original = directory.register({ namespace: "project", name: "Alice", peerId: "fixed", endpoint });
  tick();
  directory.setPresence("project", "ALICE", "online");
  expect(store.getPeer("project", "fixed")).toEqual({ ...original, presence: "online", lastSeenAt: 51 });
  errorCode(() => directory.setPresence("other", "fixed", "online"), "unknown_peer");
  errorCode(() => directory.setPresence("project", "fixed", "finished" as never), "invalid");
});

test.each([{}, { namespace: "" }, { name: " Alice" }, { peerId: "" }, { endpoint: null }, { endpoint: { host: "t3", sessionId: "", generation: 1, target: {} } }, { endpoint: { host: "t3", sessionId: "thread", generation: -1, target: {} } }, { endpoint: { host: "t3", sessionId: "thread", generation: 1, target: { threadId: 42 } } }])("invalid or missing bindings never reach storage: %j", (change) => {
  const { directory, endpoint, writes } = fixture();
  const input = Object.keys(change).length ? { namespace: "project", name: "Alice", endpoint, ...change } : {};
  errorCode(() => directory.register(input as Parameters<typeof directory.register>[0]), "invalid");
  expect(writes()).toBe(0);
});

test("caller mutation cannot silently alter a registered binding", () => {
  const { directory, endpoint, store } = fixture();
  const peer = directory.register({ namespace: "project", name: "Alice", endpoint });
  endpoint.sessionId = "mutated";
  endpoint.target.threadId = "mutated";
  peer.endpoint.target.threadId = "mutated-return";
  expect(store.getPeer("project", peer.id)?.endpoint.sessionId).toBe("thread-one");
  expect(store.getPeer("project", peer.id)?.endpoint.target.threadId).toBe("thread-one");
});

test("R2: explicit reconnect advances one generation and preserves stable alias, ID and registration", () => {
  const { directory, store, endpoint, tick, rebindings } = fixture();
  const original = directory.register({ namespace: "project", name: "Alice", peerId: "fixed", endpoint });
  directory.setPresence("project", "fixed", "busy");
  tick();
  const next: Endpoint = { ...endpoint, generation: 2, sessionId: "thread-two", target: { ...endpoint.target, threadId: "thread-two" } };
  const rebound = directory.rebind({ namespace: "project", peerId: original.id, expectedGeneration: 1, endpoint: next });
  expect(rebound).toEqual({ ...original, endpoint: next, presence: "busy", lastSeenAt: 51 });
  expect(resolvePeer(store, "project", "ALICE").id).toBe(original.id);
  expect(rebindings).toEqual([{ namespace: "project", id: original.id, expectedGeneration: 1, endpoint: next, timestamp: 51 }]);
  errorCode(() => directory.register({ namespace: "project", name: "Alice", peerId: original.id, endpoint }), "conflict");
  next.target.threadId = "caller-mutation";
  rebound.endpoint.sessionId = "return-mutation";
  expect(store.getPeer("project", original.id)?.endpoint).toMatchObject({ sessionId: "thread-two", target: { threadId: "thread-two" } });
});

test("R2: stale CAS and another peer's session conflict without changing either mailbox", () => {
  const { directory, store, endpoint } = fixture();
  const first = directory.register({ namespace: "project", name: "Alice", peerId: "alice", endpoint });
  const secondEndpoint: Endpoint = { ...endpoint, sessionId: "other", target: { threadId: "other" } };
  const second = directory.register({ namespace: "project", name: "Bob", peerId: "bob", endpoint: secondEndpoint });
  const next = { ...endpoint, generation: 2, sessionId: "new", target: { threadId: "new" } };
  const rebound = directory.rebind({ namespace: "project", peerId: first.id, expectedGeneration: 1, endpoint: next });
  errorCode(() => directory.rebind({ namespace: "project", peerId: first.id, expectedGeneration: 1, endpoint: next }), "conflict");
  errorCode(() => directory.rebind({ namespace: "project", peerId: first.id, expectedGeneration: 2, endpoint: { ...secondEndpoint, generation: 3 } }), "conflict");
  expect(store.listPeers("project")).toEqual([rebound, second]);
});

test("R2: a concurrent generation change is checked by the store CAS", () => {
  const { directory, store, endpoint, peers } = fixture();
  directory.register({ namespace: "project", name: "Alice", peerId: "fixed", endpoint });
  const rebind = store.rebindPeer;
  store.rebindPeer = (...args) => { peers[0]!.endpoint.generation = 2; return rebind(...args); };
  errorCode(() => directory.rebind({ namespace: "project", peerId: "fixed", expectedGeneration: 1, endpoint: { ...endpoint, generation: 2 } }), "conflict");
});

test.each([{}, { threadId: "another-thread" }] as Record<string, string>[])("R2: T3 registration requires target.threadId equal to sessionId: %j", (target) => {
  const { directory, endpoint, writes } = fixture();
  errorCode(() => directory.register({ namespace: "project", name: "Alice", endpoint: { ...endpoint, target } }), "invalid");
  expect(writes()).toBe(0);
});

test("R2: rebind validates namespace, peer, generation progression and T3 binding before CAS", () => {
  const { directory, endpoint, rebindings } = fixture();
  directory.register({ namespace: "project", name: "Alice", peerId: "fixed", endpoint });
  const request = { namespace: "project", peerId: "fixed", expectedGeneration: 1, endpoint: { ...endpoint, generation: 2 } };
  for (const change of [{ namespace: "" }, { peerId: "" }, { expectedGeneration: -1 }, { expectedGeneration: 1.5 }, { expectedGeneration: NaN }, { endpoint: { ...endpoint, generation: 1 } }, { endpoint: { ...endpoint, generation: 3 } }, { endpoint: { ...endpoint, generation: 2, target: { threadId: "wrong" } } }]) {
    errorCode(() => directory.rebind({ ...request, ...change }), "invalid");
  }
  errorCode(() => directory.rebind({ ...request, peerId: "unknown" }), "unknown_peer");
  expect(rebindings).toHaveLength(0);
});
