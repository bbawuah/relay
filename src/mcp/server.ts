import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Runtime } from "../app/runtime";
import { MessageError } from "../messages/contracts";

const string = { type: "string", minLength: 1 };
const tool = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties: false },
});
const TOOLS = [
  tool("send", "Store peer data as the bound peer. English fields: to, body, conversationId, replyTo, requestKey. Legacy aliases: naar, tekst, draad, antwoord_op. Receipt retries are bounded by expiresAt.", {
    to: string, body: { type: "string" }, conversationId: string, replyTo: string, requestKey: string,
    naar: string, tekst: { type: "string" }, draad: string, antwoord_op: string,
  }),
  tool("inbox", "Read unread peer data from the bound mailbox. Reading never acknowledges; use ack explicitly.", { limit: { type: "integer", minimum: 1 } }),
  tool("list", "List peer routing entries in the fixed connection namespace.", {}),
  tool("ack", "Acknowledge IDs in the bound mailbox; unknown and foreign IDs count zero.", { ids: { type: "array", items: string } }, ["ids"]),
];

type RpcId = string | number | null;
class InvalidParams extends Error {}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function fields(args: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(args).some((key) => !allowed.includes(key))) throw new InvalidParams("Unknown tool argument; sender, peer, inbox and namespace overrides are not allowed.");
}
function text(args: Record<string, unknown>, key: string, alias?: string, required = false): string | undefined {
  const value = args[key];
  const legacy = alias ? args[alias] : undefined;
  for (const field of alias ? [key, alias] : [key]) {
    if (Object.hasOwn(args, field) && typeof args[field] !== "string") throw new InvalidParams(`${field} must be a string`);
  }
  if (value !== undefined && legacy !== undefined && value !== legacy) throw new InvalidParams(`Conflicting ${key} aliases`);
  const result = value ?? legacy;
  if (result === undefined && !required) return undefined;
  if (typeof result !== "string" || (key !== "body" && !result)) throw new InvalidParams(`${key} must be a string`);
  return result;
}
const content = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

/** Newline-delimited JSON-RPC, matching the existing peers stdio framing. */
export async function serveMcp(runtime: Runtime, peerId: string): Promise<void> {
  const { namespace, service } = runtime;
  const call = (name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "send": {
        fields(args, ["to", "body", "conversationId", "replyTo", "requestKey", "naar", "tekst", "draad", "antwoord_op"]);
        const to = text(args, "to", "naar", true)!;
        const body = text(args, "body", "tekst", true)!;
        const conversationId = text(args, "conversationId", "draad");
        const replyTo = text(args, "replyTo", "antwoord_op");
        const requestKey = text(args, "requestKey") ?? randomUUID();
        return content(service.send({ namespace, from: peerId, to, body, requestKey,
          ...(conversationId === undefined ? {} : { conversationId }), ...(replyTo === undefined ? {} : { replyTo }) }));
      }
      case "inbox": {
        fields(args, ["limit"]);
        if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1)) throw new InvalidParams("limit must be a positive integer");
        return content({ kind: "peer_data", messages: service.read({ namespace, peerId, ...(args.limit === undefined ? {} : { limit: args.limit as number }) }) });
      }
      case "list": fields(args, []); return content(service.list(namespace));
      case "ack": {
        fields(args, ["ids"]);
        if (!Array.isArray(args.ids) || args.ids.some((id) => typeof id !== "string" || !id)) throw new InvalidParams("ids must be an array of message IDs");
        return content({ acknowledged: service.ack({ namespace, peerId, ids: args.ids as string[] }) });
      }
      default: throw new InvalidParams("Unknown tool");
    }
  };
  const handle = (request: unknown): unknown | null => {
    const error = (id: RpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (!record(request) || request.jsonrpc !== "2.0" || typeof request.method !== "string"
      || (Object.hasOwn(request, "id") && request.id !== null && typeof request.id !== "string" && (typeof request.id !== "number" || !Number.isFinite(request.id)))) {
      return error(null, -32600, "Invalid Request");
    }
    const hasId = Object.hasOwn(request, "id");
    // Valid JSON-RPC notifications never produce output or execute mailbox tools.
    if (!hasId) return null;
    const id = request.id as RpcId;
    if (request.params !== undefined && !record(request.params)) return error(id, -32602, "Invalid params");
    const params = request.params as Record<string, unknown> | undefined ?? {};
    try {
      let result: unknown;
      switch (request.method) {
        case "initialize": {
          const supported = ["2024-11-05", "2025-03-26", "2025-06-18"];
          result = { protocolVersion: supported.includes(String(params.protocolVersion)) ? params.protocolVersion : "2024-11-05",
            capabilities: { tools: {} }, serverInfo: { name: "peers", version: "2.0.0" } };
          break;
        }
        case "ping": result = {}; break;
        case "tools/list": result = { tools: TOOLS }; break;
        case "tools/call": {
          if (typeof params.name !== "string" || (params.arguments !== undefined && !record(params.arguments))) return error(id, -32602, "Invalid tool call");
          try { result = call(params.name, params.arguments as Record<string, unknown> | undefined ?? {}); }
          catch (cause) {
            if (cause instanceof InvalidParams) return error(id, -32602, cause.message);
            // Never serialize untrusted host errors, endpoints or exception objects.
            result = content({ error: cause instanceof MessageError ? cause.code : "internal", message: "Mailbox operation failed; check binding, address and request payload." }, true);
          }
          break;
        }
        default: return error(id, -32601, "Method not found");
      }
      return { jsonrpc: "2.0", id, result };
    } catch { return error(id, -32603, "Internal error"); }
  };
  const write = (response: unknown) => new Promise<void>((done, fail) => {
    process.stdout.write(`${JSON.stringify(response)}\n`, (error) => error ? fail(error) : done());
  });
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: unknown;
    try { request = JSON.parse(line); }
    catch { await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    const response = handle(request);
    if (response !== null) await write(response);
  }
}
