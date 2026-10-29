import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { geldigeNaam } from "../scripts/lead/peers/bus";
import { draai } from "../scripts/lead/peers/cli";
import { standaardBus } from "../scripts/lead/peers/standaard";
import { alleRecords, heeftIdentiteitsbestand, leesRecord, nieuwRecord, schrijfRecord, staatMap } from "../scripts/lead/hooks/register";
import { environment, type Environment } from "./environment";
import { launchLeases, ownerStatus, withLaunchLock } from "./identity";
import { bunArgs } from "./runtime";

export const ROOT = resolve(import.meta.dir, "..");
export const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

const HELP = `Relay ${VERSION} — local messaging between Claude, Codex and T3 sessions

  relay claude|codex --name NAME [--lead NAME] [--model MODEL] [--cwd DIR] [-- ARGS...]
  relay send NAME TEXT|- [--draad ID] [--antwoord-op ID]
  relay inbox [--niet-acken]
  relay list [--json]
  relay notify-when-idle NAME
  relay hold NAME | release NAME [ID...]
  relay status [--json] [--alles] [--lead NAME] [--git]
  relay mcp                         stdio MCP server (server name: peers)
  relay register --name NAME [--lead NAME] [--accept|--hold|--refuse]
  relay unregister ID                end a manually registered session
  relay install [--prefix DIR] [--dry-run]
  relay uninstall [--prefix DIR] [--dry-run]
  relay setup claude|codex [--dry-run] [--remove] [vendor options...]
  relay doctor

Identity: RELAY_NAME, RELAY_LEAD, RELAY_ROLE. State: RELAY_STATE_DIR.
LAB_AGENT_NAAM / LAB_LEAD_NAAM / LAB_AGENT_ROL / LAB_LEAD_STAAT remain supported.
Default state: ~/.local/state/relay. No global hooks are installed by install.
`;

export type Invocation = { command: string; args: string[]; env: Environment; explicitName?: string };

/** Global options are parsed only before the command, so message text is untouched. */
export function parse(args: string[], input: Environment): Invocation {
  const env = { ...input };
  let explicitName: string | undefined;
  let i = 0;
  const options: Record<string, string> = { "--name": "RELAY_NAME", "--lead": "RELAY_LEAD", "--role": "RELAY_ROLE", "--state": "RELAY_STATE_DIR" };
  while (options[args[i] ?? ""]) {
    const key = options[args[i]!]!;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`${args[i]} needs a value`);
    env[key] = value;
    if (key === "RELAY_NAME") explicitName = value;
    i += 2;
  }
  return { command: args[i] || "--help", args: args.slice(i + 1), env: environment(env), ...(explicitName ? { explicitName } : {}) };
}

export function register(args: string[], env: Environment, now = Date.now()): string {
  let name = env.LAB_AGENT_NAAM || "";
  let lead = env.LAB_LEAD_NAAM || "";
  let inbound: "accept" | "hold" | "refuse" | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--name" || arg === "--lead") {
      const value = args[++i];
      if (!geldigeNaam(value)) throw new Error(`${arg} requires a valid session name`);
      if (arg === "--name") name = value!;
      else lead = value!;
    } else if (arg === "--accept" || arg === "--hold" || arg === "--refuse") {
      if (inbound) throw new Error("choose one inbound policy");
      inbound = arg.slice(2) as "accept" | "hold" | "refuse";
    } else throw new Error(`unknown register option: ${arg}`);
  }
  if (!geldigeNaam(name) || (lead && !geldigeNaam(lead))) throw new Error("register requires --name NAME (letters, digits, '.', '_' or '-'; at most 100 characters)");
  const state = staatMap(env);
  return withLaunchLock(state, (db) => {
    const leases = launchLeases(db);
    const key = name.toLowerCase();
    if (leases.some((lease) => lease.name.toLowerCase() === key && ownerStatus(lease.owner) !== "dead") || alleRecords(state).some((r) => r.toestand !== "weg" && r.naam.toLowerCase() === key)) throw new Error(`session name is already registered: ${name}`);
    const id = `relay-${crypto.randomUUID()}`;
    // The record is the manual claim: publish it before releasing launch's lock.
    schrijfRecord(state, {
      ...nieuwRecord(id, { ...env, LAB_AGENT_NAAM: name, LAB_LEAD_NAAM: lead }, process.cwd(), now),
      host: "geen",
      ...(inbound ? { inbound: { standaard: inbound } } : {}),
    });
    return id;
  });
}

export async function main(argv: string[], input: Environment = process.env): Promise<number> {
  const { command, args, env, explicitName } = parse(argv, input);
  const child = async (script: string, extra: string[]): Promise<number> => {
    const p = Bun.spawn([process.execPath, ...bunArgs(join(ROOT, script), extra)], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await p.exited;
  };
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") { console.log(VERSION); return 0; }
  if (command === "mcp") {
    if (args.length) throw new Error("mcp takes no arguments; use global --name and --state before mcp");
    if (explicitName) {
      if (!geldigeNaam(explicitName)) throw new Error("MCP --name must be a valid session name");
      env.RELAY_MCP_NAME = explicitName;
    } else if (!geldigeNaam(env.RELAY_MCP_NAME) && heeftIdentiteitsbestand(staatMap(env), process.cwd(), true)) {
      // Environment defaults can belong to an older daemon/shell. A stale or
      // unknown workspace identity must not fall back to that person's inbox.
      for (const key of ["LAB_AGENT_NAAM", "LAB_LEAD_NAAM", "LAB_AGENT_ROL"]) env[key] = "";
    }
    return child("scripts/lead/peers/server.ts", []);
  }
  if (command === "status") {
    const { status, gitInfo } = await import("../scripts/lead/hooks/status");
    const project = process.cwd();
    const result = status(args, env, Date.now(), (cwd) => gitInfo(cwd, project));
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.code;
  }
  if (command === "register") { console.log(register(args, env)); return 0; }
  if (command === "unregister") {
    if (args.length !== 1 || !/^relay-[0-9a-f-]{36}$/.test(args[0]!)) throw new Error("unregister requires the ID returned by relay register");
    const r = leesRecord(staatMap(env), args[0]!);
    if (!r) throw new Error("manual session not found");
    schrijfRecord(staatMap(env), { ...r, toestand: "weg", sinds: Date.now(), einde: Date.now() });
    const bus = standaardBus(env);
    await bus.idleGemeld(r.naam, "weg");
    await bus.klaar();
    return 0;
  }
  if (command === "install" || command === "uninstall") {
    const { install, uninstall } = await import("./install");
    console.log((command === "install" ? install : uninstall)(args, env));
    return 0;
  }
  if (command === "claude" || command === "codex") {
    const { launch } = await import("./launch");
    return launch(command, args, env);
  }
  if (command === "setup") {
    const [vendor, ...options] = args;
    const translated = options.map((a) => a === "--dry-run" ? "--droog" : a === "--remove" ? "--verwijder" : a);
    if (vendor === "claude") return child("scripts/lead/installeer-hooks.ts", ["--staat", env.LAB_LEAD_STAAT!, ...translated]);
    if (vendor === "codex") return child("scripts/lead/hooks/codex-installeer.ts", ["--staat", env.LAB_LEAD_STAAT!, ...translated]);
    throw new Error("setup requires claude or codex");
  }
  if (command === "doctor") {
    if (args.length) throw new Error("doctor takes no arguments");
    console.log(`Relay ${VERSION}\nBun ${Bun.version}\nState: ${staatMap(env)}`);
    if (Bun.version === "1.4.2") console.log("Bun 1.4.2 can print a 'directory mismatch' diagnostic even when Relay succeeds. Startup isolation remains enabled; see README.");
    for (const name of ["claude", "codex", "t3", "tmux", "git", "jq", "python3"]) console.log(`${name}: ${Bun.which(name) || "not installed (optional)"}`);
    const required = ["scripts/lead/peers/server.ts", "scripts/lead/hooks/register.ts", "scripts/lead/hooks/codex-wrap.ts"];
    if (required.some((file) => !existsSync(join(ROOT, file)))) throw new Error("incomplete Relay installation; reinstall from a complete checkout");
    return 0;
  }
  const aliases: Record<string, string> = { ls: "list", hold: "vasthouden", release: "vrijgeven" };
  const cmd = aliases[command] || command;
  if (!["send", "inbox", "list", "notify-when-idle", "vasthouden", "vrijgeven"].includes(cmd)) throw new Error(`unknown command: ${command}\nRun relay --help`);
  const result = await draai([cmd, ...args], env, standaardBus(env));
  process.stdout.write(result.uit);
  process.stderr.write(result.fout);
  return result.code;
}
