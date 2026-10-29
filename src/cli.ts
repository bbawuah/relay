import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bindPeer, openRuntime, settings } from "./app/runtime";
import { dispatchOnce } from "./dispatch";
import { environment, type Environment } from "./environment";
import type { Endpoint } from "./messages/contracts";

export const ROOT = resolve(import.meta.dir, "..");
export const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const MIGRATION = "Relay v2 is message-only. Roles, policy, launch and idle subscriptions were retired. Use register, explicit --peer ID, send, inbox and ack; import legacy mail into a separate v2 state directory.";
const RETIRED = new Set(["--role", "--lead", "--name", "--accept", "--hold", "--refuse", "hold", "release", "vasthouden", "vrijgeven", "setup", "claude", "codex", "launch", "policy", "notify-when-idle", "notify_when_idle"]);
const NOTIFICATIONS = "No notification adapters are shipped. All hosts (manual, t3, claude, codex) must poll inbox. serve records only deferrals/diagnoses and never wakes sessions.";
const HELP = `Relay ${VERSION} — local message mailboxes (v2)

Global options precede commands: --state DIR --namespace NAME --peer ID
  register --name NAME [--host manual|t3|claude|codex] [--session-id ID] [--json]
  list [--json]
  send TO TEXT|- [--request-key KEY] [--conversation ID] [--reply-to ID] [--json]
  inbox [--json] [--limit N]     read unread messages without acknowledging
  ack ID... [--json]           acknowledge only the bound mailbox
  unregister ID               mark offline, preserve the mailbox
  rebind --peer ID --expected-generation N --host HOST --session-id ID
  status [--json]
  serve [--once]               record notification deferrals/diagnoses; never wakes sessions
  migrate --source DIR --source-quiesced [--held quarantine|import|skip]
  mcp                         stdio server peers; explicit global --peer ID required
  install|uninstall [--prefix DIR] [--dry-run]
  doctor | help | --version

State: RELAY_STATE_DIR (default ~/.local/state/relay/v2).
Namespace: RELAY_NAMESPACE (default local). CLI binding: --peer or RELAY_PEER_ID.
MCP requires a stable peer ID on its command line; environment identity is ignored.
${NOTIFICATIONS}
Migration destination is --state; namespace is --namespace. Held mail defaults to quarantine.
Inbox never acknowledges automatically. Send returns a stored receipt and request key.
`;

export type Invocation = { command: string; args: string[]; env: Environment; explicitPeer?: string };

/** Only the prefix is global; positional message bodies are always literal. */
export function parse(args: string[], input: Environment): Invocation {
  const env = { ...input };
  let explicitPeer: string | undefined;
  let i = 0;
  const options: Record<string, string> = { "--state": "RELAY_STATE_DIR", "--namespace": "RELAY_NAMESPACE", "--peer": "RELAY_PEER_ID" };
  const seen = new Set<string>();
  while (Object.hasOwn(options, args[i] ?? "")) {
    const option = args[i]!;
    if (seen.has(option)) throw new Error(`duplicate global option: ${option}`);
    seen.add(option);
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${option} needs a value`);
    env[options[option]!] = value;
    if (option === "--peer") explicitPeer = value;
    i += 2;
  }
  if (RETIRED.has(args[i] ?? "")) throw new Error(MIGRATION);
  return { command: args[i] || "help", args: args.slice(i + 1), env: environment(env), ...(explicitPeer ? { explicitPeer } : {}) };
}

function options(args: string[], flags: string[], values: string[]) {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (Object.hasOwn(result, key)) throw new Error(`duplicate option: ${key}`);
    if (flags.includes(key)) result[key] = true;
    else if (values.includes(key)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${key} needs a value`);
      result[key] = value;
    } else if (RETIRED.has(key)) throw new Error(MIGRATION);
    else throw new Error(`unknown option: ${key}; global options must precede the command`);
  }
  return result;
}

function integer(value: string, label: string, minimum = 1) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return Number(value);
}

function endpoint(host: string, sessionId: string | undefined, generation: number): Endpoint {
  if (!["manual", "t3", "claude", "codex"].includes(host)) throw new Error("host must be manual, t3, claude or codex");
  if (!sessionId && host !== "manual") throw new Error(`${host} requires an explicit --session-id ID`);
  const session = sessionId ?? `manual-${randomUUID()}`;
  return { host, sessionId: session, generation, target: host === "t3" ? { threadId: session } : {} };
}

function output(value: unknown, json: boolean, plain?: string) {
  console.log(json || plain === undefined ? JSON.stringify(value) : plain);
}

export async function main(argv: string[], input: Environment = process.env): Promise<number> {
  const { command, args, env, explicitPeer } = parse(argv, input);
  if (["help", "--help", "-h"].includes(command)) { options(args, [], []); console.log(HELP); return 0; }
  if (["--version", "-v", "version"].includes(command)) { options(args, [], []); console.log(VERSION); return 0; }
  if (command === "doctor") {
    options(args, [], []);
    const config = settings(env);
    console.log(`Relay ${VERSION}\nBun ${Bun.version}; SQLite: built-in bun:sqlite\nState: ${config.state}\nNamespace: ${config.namespace}\nDispatcher limits: timeout 10000ms, lease > timeout + 1000ms.\n${NOTIFICATIONS}\nT3 notifications: unsupported / polling (no proven safe external transport).\nMailbox send/read/ack work independently of host notifications.`);
    return 0;
  }
  if (command === "migrate") {
    const opts = options(args, ["--source-quiesced"], ["--source", "--held"]);
    const source = opts["--source"];
    if (typeof source !== "string" || !source.trim()) throw new Error("migrate requires --source DIR");
    if (opts["--source-quiesced"] !== true) throw new Error("Stop old writers, then explicitly assert --source-quiesced before migration.");
    const held = opts["--held"] ?? "quarantine";
    if (held !== "quarantine" && held !== "import" && held !== "skip") throw new Error("--held must be quarantine, import or skip");
    const { state: destinationDir, namespace } = settings(env);
    // F owns validation, database/ledger lifetime and recovery. Other commands
    // never load or execute the source migration module.
    const { migrateLegacy } = await import("./migration/index");
    output(migrateLegacy({ sourceDir: resolve(source), destinationDir, namespace, sourceQuiesced: true, held }), true);
    return 0;
  }
  if (command === "install" || command === "uninstall") {
    const { install, uninstall } = await import("./install");
    console.log((command === "install" ? install : uninstall)(args, env));
    return 0;
  }
  if (command === "mcp") {
    options(args, [], []);
    if (!explicitPeer) throw new Error("MCP requires explicit global --peer ID before mcp; RELAY_PEER_ID and shared environment cannot bind it.");
    const runtime = openRuntime(env);
    try {
      const peer = bindPeer(runtime, explicitPeer, true);
      const { serveMcp } = await import("./mcp/server");
      await serveMcp(runtime, peer.id);
    } finally { runtime.close(); }
    return 0;
  }

  let opts: Record<string, string | boolean> = {};
  if (command === "register") {
    opts = options(args, ["--json"], ["--name", "--host", "--session-id"]);
    if (typeof opts["--name"] !== "string") throw new Error("register requires --name NAME");
    endpoint(String(opts["--host"] ?? "manual"), opts["--session-id"] as string | undefined, 0);
  } else if (command === "send") {
    if (args.length < 2) throw new Error("send requires TO TEXT|- followed by options");
    opts = options(args.slice(2), ["--json"], ["--request-key", "--conversation", "--reply-to"]);
  } else if (command === "inbox") {
    opts = options(args, ["--json"], ["--limit"]);
    if (opts["--limit"] !== undefined) integer(String(opts["--limit"]), "limit");
  } else if (command === "ack") {
    const ids = args.filter((arg) => arg !== "--json");
    if (!ids.length || ids.some((arg) => arg.startsWith("--"))) throw new Error("ack requires message IDs and optional --json");
    opts = options(args.filter((arg) => arg === "--json"), ["--json"], []);
  } else if (command === "rebind") {
    opts = options(args, [], ["--peer", "--expected-generation", "--host", "--session-id"]);
    for (const key of ["--peer", "--expected-generation", "--host", "--session-id"]) if (opts[key] === undefined) throw new Error(`rebind requires ${key}`);
    integer(String(opts["--expected-generation"]), "expected generation", 0);
    endpoint(String(opts["--host"]), String(opts["--session-id"]), 1);
  } else if (command === "list" || command === "status") opts = options(args, ["--json"], []);
  else if (command === "serve") opts = options(args, ["--once"], []);
  else if (command === "unregister") {
    if (args.length !== 1 || args[0]!.startsWith("--")) throw new Error("unregister requires a stable peer ID");
  } else throw new Error(`unknown command: ${command}\nRun relay --help`);
  if (["send", "inbox", "ack"].includes(command) && !env.RELAY_PEER_ID) throw new Error("Use explicit --peer ID before the command (or RELAY_PEER_ID for CLI).");

  const runtime = openRuntime(env, command === "register");
  const { namespace, store, service, directory } = runtime;
  try {
    if (command === "register") {
      const peer = directory.register({ namespace, name: String(opts["--name"]), endpoint: endpoint(String(opts["--host"] ?? "manual"), opts["--session-id"] as string | undefined, 0) });
      output(peer, !!opts["--json"], peer.id);
    } else if (command === "list") output(service.list(namespace), !!opts["--json"]);
    else if (command === "send") {
      const peer = bindPeer(runtime, env.RELAY_PEER_ID);
      const body = args[1] === "-" ? await Bun.stdin.text() : args[1]!;
      const receipt = service.send({ namespace, from: peer.id, to: args[0]!, body,
        requestKey: (opts["--request-key"] as string | undefined) ?? randomUUID(),
        ...(opts["--conversation"] ? { conversationId: String(opts["--conversation"]) } : {}),
        ...(opts["--reply-to"] ? { replyTo: String(opts["--reply-to"]) } : {}),
      });
      output(receipt, !!opts["--json"]);
    } else if (command === "inbox") {
      const peer = bindPeer(runtime, env.RELAY_PEER_ID);
      output(service.read({ namespace, peerId: peer.id, ...(opts["--limit"] ? { limit: Number(opts["--limit"]) } : {}) }), !!opts["--json"]);
    } else if (command === "ack") {
      const peer = bindPeer(runtime, env.RELAY_PEER_ID);
      output({ acknowledged: service.ack({ namespace, peerId: peer.id, ids: args.filter((arg) => arg !== "--json") }) }, !!opts["--json"]);
    } else if (command === "unregister") {
      if (!store.getPeer(namespace, args[0]!)) throw new Error("unregister requires an existing stable peer ID");
      directory.setPresence(namespace, args[0]!, "offline");
      output({ id: args[0], presence: "offline" }, true);
    } else if (command === "rebind") {
      const expectedGeneration = Number(opts["--expected-generation"]);
      output(directory.rebind({ namespace, peerId: String(opts["--peer"]), expectedGeneration,
        endpoint: endpoint(String(opts["--host"]), String(opts["--session-id"]), expectedGeneration + 1) }), true);
    } else if (command === "status") {
      output({ namespace, state: runtime.state, peers: service.list(namespace).map((peer) => ({ ...peer, unread: store.unread(namespace, peer.id) })),
        notifications: store.notificationStatus(namespace), dispatcher: NOTIFICATIONS, t3: "unsupported/polling" }, !!opts["--json"]);
    } else if (command === "serve") {
      let stopped = false;
      const stop = () => { stopped = true; };
      process.on("SIGINT", stop); process.on("SIGTERM", stop);
      try {
        do {
          output({ ...await dispatchOnce({ store, adapters: [], leaseMs: 30_000 }), delivery: "unsupported/polling", detail: NOTIFICATIONS }, true);
          if (!opts["--once"] && !stopped) await new Promise((done) => setTimeout(done, 1000));
        } while (!opts["--once"] && !stopped);
      } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    }
  } finally { runtime.close(); }
  return 0;
}
