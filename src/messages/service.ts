import { createHash, randomUUID } from "node:crypto";
import { resolvePeer } from "../directory";
import * as validate from "../directory/validation";
import { MessageError, PROTOCOL_VERSION, type Envelope, type MessageStore, type Peer, type Receipt, type SendRequest } from "./contracts";

export type MessageServiceOptions = {
  store: MessageStore;
  now?: () => number;
  id?: () => string;
  maxPending?: number;
  maxBodyBytes?: number;
};
export type ReadRequest = { namespace: string; peerId: string; limit?: number };
export type AckRequest = { namespace: string; peerId: string; ids: string[] };

export function createMessageService({ store, now = Date.now, id = randomUUID, maxPending = 1000, maxBodyBytes = 16000 }: MessageServiceOptions) {
  validate.positiveInteger(maxPending, "maxPending");
  validate.positiveInteger(maxBodyBytes, "maxBodyBytes");
  const nextId = (label: string) => {
    const value = id();
    validate.address(value, label);
    return value;
  };

  return {
    send(request: SendRequest): Receipt {
      validate.record(request, "send request");
      validate.address(request.namespace, "namespace");
      validate.address(request.from, "from");
      validate.address(request.to, "to");
      if (typeof request.body !== "string") throw new MessageError("invalid", "body must be a string");
      for (const field of ["conversationId", "replyTo", "requestKey"] as const) {
        if (request[field] !== undefined) validate.address(request[field], field);
      }
      const from = resolvePeer(store, request.namespace, request.from);
      const to = resolvePeer(store, request.namespace, request.to);
      // Fixed field order and JSON escaping avoid delimiter collisions. Only caller
      // inputs are included: omitted conversationId must stay omitted on retries.
      const fingerprint = createHash("sha256").update(JSON.stringify({
        namespace: request.namespace, from: from.id, to: to.id, body: request.body,
        conversationId: request.conversationId ?? null, replyTo: request.replyTo ?? null,
      })).digest("hex");
      if (request.requestKey !== undefined) {
        const receipt = store.lookupReceipt(request.namespace, from.id, request.requestKey, fingerprint);
        if (receipt) return receipt;
      }
      if (Buffer.byteLength(request.body, "utf8") > maxBodyBytes) {
        throw new MessageError("too_large", `body exceeds ${maxBodyBytes} UTF-8 bytes`);
      }
      let conversationId = request.conversationId;
      if (request.replyTo !== undefined) {
        const parent = store.getMessageReference(request.namespace, request.replyTo);
        if (!parent) throw new MessageError("invalid", "reply reference is missing or expired in this namespace");
        if (parent.namespace !== request.namespace
          || !((parent.from === from.id && parent.to === to.id) || (parent.from === to.id && parent.to === from.id))) {
          throw new MessageError("invalid", "reply must reference an existing message between these peers in the same namespace");
        }
        if (conversationId !== undefined && conversationId !== parent.conversationId) {
          throw new MessageError("invalid", "reply conversationId does not match the referenced message");
        }
        conversationId = parent.conversationId;
      }
      const message: Envelope = {
        version: PROTOCOL_VERSION, id: nextId("message id"), namespace: request.namespace, from: from.id, to: to.id,
        body: request.body, conversationId: conversationId ?? nextId("conversation id"), createdAt: validate.timestamp(now),
        ...(request.replyTo === undefined ? {} : { replyTo: request.replyTo }),
      };
      // The store atomically checks the key again, mailbox bounds, and commits
      // envelope + receipt + notification job. No host availability is involved.
      return store.enqueue({ message, fingerprint, maxPending, maxBodyBytes,
        ...(request.requestKey === undefined ? {} : { requestKey: request.requestKey }),
      });
    },

    read(input: ReadRequest): Envelope[] {
      validate.record(input, "read request");
      if (input.limit !== undefined) validate.positiveInteger(input.limit, "limit");
      const peer = resolvePeer(store, input.namespace, input.peerId);
      return structuredClone(store.read(input.namespace, peer.id, input.limit));
    },

    ack(input: AckRequest): number {
      validate.record(input, "ack request");
      if (!Array.isArray(input.ids)) throw new MessageError("invalid", "ids must be an array");
      for (const value of input.ids) validate.address(value, "message id");
      const peer = resolvePeer(store, input.namespace, input.peerId);
      return store.ack(input.namespace, peer.id, [...new Set(input.ids)], validate.timestamp(now));
    },

    list(namespace: string): Peer[] {
      validate.address(namespace, "namespace");
      return structuredClone(store.listPeers(namespace));
    },
  };
}
