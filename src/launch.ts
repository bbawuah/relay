import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { genereer } from "../scripts/lead/beleid/claude";
import { beleid } from "../scripts/lead/beleid/beleid";
import { geldigeNaam } from "../scripts/lead/peers/bus";
import { alleRecords, heeftIdentiteitsbestand, schrijfIdentiteit, schrijfRecord, wisIdentiteit, staatMap } from "../scripts/lead/hooks/register";
import { standaardBus } from "../scripts/lead/peers/standaard";
import { blokIn } from "../scripts/lead/hooks/codex-installeer";
import { startAppServer } from "../scripts/lead/hooks/codex-appserver";
import { staatOmgeving, EVENTS, MERK } from "../scripts/lead/hooks/codex-installeer";
import { environment, type Environment } from "./environment";

const ROOT = resolve(import.meta.dir, "..");

export function launchPlan(vendor: "claude" | "codex", args: string[], input: Environment) {
  let env = environment(input);
  let name = env.LAB_AGENT_NAAM || "";
  let lead = env.LAB_LEAD_NAAM || "";
  let cwd = process.cwd();
  let model = "";
  let extra: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { extra = args.slice(i + 1); break; }
    if (!["--name", "--lead", "--cwd", "--model"].includes(arg)) throw new Error(`unknown launch option: ${arg}; put vendor arguments after --`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    if (arg === "--name") name = value;
    else if (arg === "--lead") lead = value;
    else if (arg === "--cwd") cwd = resolve(value);
    else model = value;
  }
  if (!geldigeNaam(name) || (lead && !geldigeNaam(lead))) throw new Error("use --name NAME and a valid --lead NAME");
  const reserved = vendor === "claude" ? ["--settings", "--mcp-config", "--setting-sources"] : ["-C", "--cd", "-c", "--config", "--profile", "-p"];
  if (extra.some((arg) => reserved.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) throw new Error("pass directory/model through Relay options; settings that replace Relay hooks or identity cannot be passed after --");
  cwd = realpathSync(cwd);
  const role = vendor === "claude" && (!lead || lead === name) ? "lead" : "agent";
  env = { ...env, LAB_AGENT_NAAM: name, LAB_LEAD_NAAM: lead || (role === "lead" ? name : ""), LAB_AGENT_ROL: role, LAB_LEAD_BUN: process.execPath, LAB_SPAWN_ID: crypto.randomUUID() };
  // A parent's RELAY_* identity must not override this launch in its MCP subprocess.
  delete env.RELAY_NAME;
  delete env.RELAY_LEAD;
  delete env.RELAY_ROLE;
  const mcpEnv = Object.fromEntries(["LAB_AGENT_NAAM", "LAB_LEAD_NAAM", "LAB_AGENT_ROL", "LAB_LEAD_STAAT"].map((key) => [key, env[key]!]));
  const server = { command: process.execPath, args: [join(ROOT, "bin/relay.ts"), "mcp"], env: mcpEnv };
  const argv: string[] = [vendor];
  if (vendor === "claude") {
    const generated = genereer(beleid, "claude", { doel: join(ROOT, "scripts/lead/hooks"), bun: process.execPath, staat: env.LAB_LEAD_STAAT, metWekker: false, verwijder: false, settings: "", bestaand: {} });
    argv.push("-n", name, "--settings", generated.bestanden[0]!.inhoud, "--mcp-config", JSON.stringify({ mcpServers: { peers: server } }));
    if (model) argv.push("--model", model);
  } else {
    // Codex's daemon ignores per-TUI environment. Persistent, trusted hooks and a
    // per-checkout identity are required; never bypass hook trust or sandbox policy.
    const home = env.CODEX_HOME || join(env.HOME || "", ".codex");
    argv.push("-C", cwd);
    if (model) argv.push("-m", model);
    for (const [key, value] of Object.entries(server)) argv.push("-c", `mcp_servers.peers.${key}=${key === "env" ? `{${Object.entries(value as Record<string, string>).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(",")}}` : JSON.stringify(value)}`);
    env.CODEX_HOME = home;
  }
  return { argv: [...argv, ...extra], env, cwd, name, vendor };
}

export async function launch(vendor: "claude" | "codex", args: string[], input: Environment): Promise<number> {
  const plan = launchPlan(vendor, args, input);
  const state = staatMap(plan.env);
  if (!Bun.which(vendor)) throw new Error(`${vendor} is not installed; install and authenticate its CLI first`);
  if (alleRecords(state).some((r) => r.toestand !== "weg" && r.naam.toLowerCase() === plan.name.toLowerCase())) throw new Error(`session name already active: ${plan.name}`);
  if (vendor === "codex") {
    const config = join(plan.env.CODEX_HOME!, "config.toml");
    if (!existsSync(config) || !blokIn(readFileSync(config, "utf8"))) throw new Error("Codex hooks are not configured. Run relay setup codex --dry-run, then relay setup codex.");
    if (heeftIdentiteitsbestand(state, plan.cwd)) throw new Error("this checkout already has a session identity; use a separate worktree");
    const server = await startAppServer("codex", plan.env.CODEX_HOME!, plan.cwd);
    try {
      const own = (await server.hooks(plan.cwd)).filter((hook) => hook.command.includes(MERK));
      if (own.length !== EVENTS.length || own.some((hook) => !["trusted", "managed"].includes(hook.trustStatus) || !hook.command.includes(` ${staatOmgeving(state)} `))) throw new Error("Codex hooks are untrusted or use another state directory; run relay setup codex for this bus");
    } finally { server.sluit(); }
    schrijfIdentiteit(state, plan.cwd, { naam: plan.name, rol: "agent", lead: plan.env.LAB_LEAD_NAAM!, opdracht: "", spawn_id: plan.env.LAB_SPAWN_ID!, ts: Date.now() });
  }
  let p: ReturnType<typeof Bun.spawn> | undefined;
  const interrupt = () => p?.kill("SIGINT");
  const terminate = () => p?.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    p = Bun.spawn(plan.argv, { cwd: plan.cwd, env: plan.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await p.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    if (vendor === "codex") wisIdentiteit(state, plan.cwd, plan.env.LAB_SPAWN_ID!);
    // A CLI crash may omit SessionEnd. Retire only records from this exact launch.
    const owned = alleRecords(state).filter((record) => record.spawn_id === plan.env.LAB_SPAWN_ID && record.toestand !== "weg");
    for (const record of owned) schrijfRecord(state, { ...record, toestand: "weg", sinds: Date.now(), einde: Date.now() });
    if (owned.length) {
      const bus = standaardBus(plan.env);
      for (const record of owned) await bus.idleGemeld(record.naam, "weg");
      await bus.klaar();
    }
  }
}
