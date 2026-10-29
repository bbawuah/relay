import { randomUUID } from "node:crypto";
import { MessageError, type Endpoint, type MessageStore, type Peer, type Presence } from "../messages/contracts";
import * as validate from "./validation";

export type DirectoryOptions = { store: MessageStore; now?: () => number; id?: () => string };
export type RegisterRequest = { namespace: string; name: string; endpoint: Endpoint; peerId?: string };
export type RebindRequest = { namespace: string; peerId: string; expectedGeneration: number; endpoint: Endpoint };

/** Never let a display alias shadow a different stable peer ID. */
export function resolvePeer(store: MessageStore, namespace: string, reference: string): Peer {
  validate.address(namespace, "namespace");
  validate.address(reference, "peer reference");
  const byId = store.getPeer(namespace, reference);
  const byName = store.findPeer(namespace, reference);
  if (byId && byName && byId.id !== byName.id) {
    throw new MessageError("conflict", `ambiguous peer reference: ${reference}`);
  }
  const peer = byId ?? byName;
  if (!peer) throw new MessageError("unknown_peer", `unknown peer in namespace ${namespace}: ${reference}`);
  return peer;
}

function sameEndpoint(left: Endpoint, right: Endpoint): boolean {
  const entries = (target: Record<string, string>) => Object.entries(target).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return left.host === right.host && left.sessionId === right.sessionId && left.generation === right.generation
    && JSON.stringify(entries(left.target)) === JSON.stringify(entries(right.target));
}

export function createDirectory({ store, now = Date.now, id = randomUUID }: DirectoryOptions) {
  return {
    register(input: RegisterRequest): Peer {
      validate.record(input, "registration");
      validate.address(input.namespace, "namespace");
      validate.address(input.name, "name");
      validate.endpoint(input.endpoint);
      if (input.peerId !== undefined) validate.address(input.peerId, "peerId");
      const { namespace, name, endpoint } = input;
      const byId = input.peerId === undefined ? null : store.getPeer(namespace, input.peerId);
      const byName = store.findPeer(namespace, name);
      const sessions = store.listPeers(namespace).filter((peer) => peer.endpoint.host === endpoint.host && peer.endpoint.sessionId === endpoint.sessionId);
      const candidates = [byId, byName, ...sessions].filter((peer): peer is Peer => peer !== null);
      const existing = candidates[0];
      if (existing) {
        if (candidates.some((peer) => peer.id !== existing.id)
          || (input.peerId !== undefined && input.peerId !== existing.id)
          || existing.name.toLowerCase() !== name.toLowerCase()
          || !sameEndpoint(existing.endpoint, endpoint)) {
          throw new MessageError("conflict", "peer ID, alias or host session is already bound; registration cannot rebind it");
        }
        // Preserve observed presence, timestamps and original display spelling on retry.
        return structuredClone(store.register(structuredClone(existing)));
      }
      const peerId = input.peerId ?? id();
      validate.address(peerId, "generated peerId");
      const nameAsId = store.getPeer(namespace, name);
      const idAsName = store.findPeer(namespace, peerId);
      if ((nameAsId && nameAsId.id !== peerId) || (idAsName && idAsName.id !== peerId)) {
        throw new MessageError("conflict", "registration would make an alias and peer ID ambiguous");
      }
      const time = validate.timestamp(now);
      const peer: Peer = {
        id: peerId, namespace, name, endpoint: structuredClone(endpoint), presence: "offline", registeredAt: time, lastSeenAt: time,
      };
      // Atomic uniqueness and immutable binding are also enforced by the store.
      return structuredClone(store.register(peer));
    },

    rebind(input: RebindRequest): Peer {
      validate.record(input, "rebind request");
      validate.address(input.namespace, "namespace");
      validate.address(input.peerId, "peerId");
      validate.endpoint(input.endpoint);
      if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
        throw new MessageError("invalid", "expectedGeneration must be a nonnegative safe integer");
      }
      if (input.endpoint.generation !== input.expectedGeneration + 1) {
        throw new MessageError("invalid", "rebind endpoint generation must advance expectedGeneration by exactly one");
      }
      const peer = resolvePeer(store, input.namespace, input.peerId);
      // The store checks the current generation and session uniqueness atomically.
      // A preflight read cannot authorize overwriting a concurrent reconnect.
      return structuredClone(store.rebindPeer(input.namespace, peer.id, input.expectedGeneration, structuredClone(input.endpoint), validate.timestamp(now)));
    },

    setPresence(namespace: string, peerId: string, presence: Presence): void {
      validate.presence(presence);
      const peer = resolvePeer(store, namespace, peerId);
      store.setPresence(namespace, peer.id, presence, validate.timestamp(now));
    },
  };
}
