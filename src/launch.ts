import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { genereer } from "../scripts/lead/beleid/claude";
import { beleid } from "../scripts/lead/beleid/beleid";
import { geldigeNaam } from "../scripts/lead/peers/bus";
import { alleRecords, heeftIdentiteitsbestand, schrijfIdentiteit, schrijfRecord, ruimDodeLauncherIdentiteitenOp, wisLauncherIdentiteit, staatMap } from "../scripts/lead/hooks/register";
import { standaardBus } from "../scripts/lead/peers/standaard";
import { blokIn } from "../scripts/lead/hooks/codex-installeer";
import { startAppServer } from "../scripts/lead/hooks/codex-appserver";
import { staatOmgeving, EVENTS, MERK } from "../scripts/lead/hooks/codex-installeer";
import { environment, type Environment } from "./environment";
import { bunArgs } from "./runtime";
import { kiesBun } from "../scripts/lead/installeer-hooks";
import { deleteLaunchLease, launcherOwner, launchLeases, ownerStatus, saveLaunchLease, withLaunchLock } from "./identity";

const ROOT = resolve(import.meta.dir, "..");

export function launchPlan(vendor: "claude" | "codex", args: string[], input: Environment, runtimeBun?: string) {
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
  const reserved = vendor === "claude"
    ? ["--settings", "--mcp-config", "--setting-sources", "--name", "--agent", "--agents", "--plugin-dir", "--bare", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode", "--worktree", "-n", "-w"]
    : ["-C", "--cd", "-c", "--config", "--profile", "-p", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--yolo", "--sandbox", "-s", "--ask-for-approval", "-a", "--disable", "--enable"];
  for (const arg of extra) {
    if (arg === "--") break; // The vendor treats subsequent strings as literal prompt text.
    if (reserved.some((flag) => flag.startsWith("--") ? arg === flag || arg.startsWith(`${flag}=`) : arg.startsWith(flag))) throw new Error("pass directory/model through Relay options; settings that replace Relay hooks or identity cannot be passed after --");
  }
  cwd = realpathSync(cwd);
  const bun = runtimeBun ?? kiesBun((name) => Bun.which(name, { PATH: env.PATH ?? process.env.PATH ?? "" }));
  env = { ...env, LAB_AGENT_NAAM: name, LAB_LEAD_NAAM: lead, LAB_AGENT_ROL: "agent", LAB_LEAD_BUN: bun, LAB_SPAWN_ID: crypto.randomUUID() };
  // A parent's RELAY_* identity must not override this launch in its MCP subprocess.
  delete env.RELAY_NAME;
  delete env.RELAY_LEAD;
  delete env.RELAY_ROLE;
  delete env.RELAY_MCP_NAME;
  const mcpEnv = Object.fromEntries(["LAB_AGENT_NAAM", "LAB_LEAD_NAAM", "LAB_AGENT_ROL", "LAB_LEAD_STAAT"].map((key) => [key, env[key]!]));
  // Explicit values override stale aliases inherited from a shared daemon.
  mcpEnv.RELAY_STATE_DIR = env.LAB_LEAD_STAAT!;
  for (const key of ["RELAY_NAME", "RELAY_LEAD", "RELAY_ROLE", "RELAY_MCP_NAME"]) mcpEnv[key] = "";
  for (const key of ["BUN_OPTIONS", "NODE_OPTIONS"]) mcpEnv[key] = "";
  // Codex can restart MCP after its launcher dies. Resolve its identity from the
  // live checkout owner, rather than falling back to the inherited TUI identity.
  if (vendor === "codex") for (const key of ["LAB_AGENT_NAAM", "LAB_LEAD_NAAM", "LAB_AGENT_ROL"]) mcpEnv[key] = "";
  else mcpEnv.RELAY_MCP_NAME = name;
  const server = { command: bun, args: bunArgs(join(ROOT, "bin/relay.ts"), ["mcp"]), env: mcpEnv };
  const argv: string[] = [vendor];
  if (vendor === "claude") {
    const generated = genereer(beleid, "claude", { doel: join(ROOT, "scripts/lead/hooks"), bun, staat: env.LAB_LEAD_STAAT, metWekker: false, verwijder: false, settings: "", bestaand: {} });
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

export function verifiedBun(input: Environment): string {
  const env = environment(input);
  const preferred = kiesBun((name) => Bun.which(name, { PATH: env.PATH ?? "" }));
  for (const bun of new Set([preferred, process.execPath])) {
    try {
      const result = Bun.spawnSync([bun, ...bunArgs("--version")], { cwd: ROOT, env: { HOME: env.HOME, PATH: "/usr/bin:/bin", BUN_OPTIONS: "", NODE_OPTIONS: "" }, stdout: "pipe", stderr: "pipe", timeout: 1000 });
      const version = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(result.stdout.toString().trim());
      if (result.exitCode === 0 && version && (Number(version[1]) > 1 || (Number(version[1]) === 1 && (Number(version[2]) > 4 || (Number(version[2]) === 4 && Number(version[3]) >= 2))))) return bun;
    } catch { /* Try the running, trusted runtime before reporting incompatibility. */ }
  }
  throw new Error("Relay launch requires Bun >= 1.4.2; neither PATH Bun nor the running Bun is compatible");
}

export async function launch(vendor: "claude" | "codex", args: string[], input: Environment): Promise<number> {
  const plan = launchPlan(vendor, args, input, verifiedBun(input));
  const state = staatMap(plan.env);
  const executable = Bun.which(vendor, { PATH: plan.env.PATH ?? "" });
  if (!executable) throw new Error(`${vendor} is not installed; install and authenticate its CLI first`);
  if (vendor === "codex") {
    const config = join(plan.env.CODEX_HOME!, "config.toml");
    if (!existsSync(config) || !blokIn(readFileSync(config, "utf8"))) throw new Error("Codex hooks are not configured. Run relay setup codex --dry-run, then relay setup codex.");
    const server = await startAppServer("codex", plan.env.CODEX_HOME!, plan.cwd);
    try {
      const own = (await server.hooks(plan.cwd)).filter((hook) => hook.command.includes(MERK));
      if (own.length !== EVENTS.length || own.some((hook) => !["trusted", "managed"].includes(hook.trustStatus) || !hook.command.includes(` ${staatOmgeving(state)} `))) throw new Error("Codex hooks are untrusted or use another state directory; run relay setup codex for this bus");
    } finally { server.sluit(); }
  }
  const spawn = plan.env.LAB_SPAWN_ID!;
  const owner = launcherOwner();
  withLaunchLock(state, (db) => {
    const leases = launchLeases(db);
    const dead = leases.filter((lease) => ownerStatus(lease.owner) === "dead");
    const stale = new Set([...dead.map((lease) => lease.spawn), ...ruimDodeLauncherIdentiteitenOp(state)]);
    for (const record of alleRecords(state)) {
      if (record.spawn_id && stale.has(record.spawn_id) && record.toestand !== "weg") schrijfRecord(state, { ...record, toestand: "weg", sinds: Date.now(), einde: Date.now() });
    }
    for (const lease of dead) deleteLaunchLease(db, lease.spawn);
    const live = leases.filter((lease) => !stale.has(lease.spawn));
    if (live.some((lease) => lease.name.toLowerCase() === plan.name.toLowerCase()) || alleRecords(state).some((r) => r.toestand !== "weg" && r.naam.toLowerCase() === plan.name.toLowerCase())) throw new Error(`session name already active: ${plan.name}`);
    if (vendor === "codex") {
      const contains = (parent: string, child: string) => parent === child || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
      if (heeftIdentiteitsbestand(state, plan.cwd) || live.some((lease) => lease.vendor === "codex" && (contains(lease.cwd, plan.cwd) || contains(plan.cwd, lease.cwd)))) throw new Error("this checkout already has a session identity; use a separate worktree");
    }
    saveLaunchLease(db, { spawn, name: plan.name, cwd: plan.cwd, vendor, owner });
    if (vendor === "codex") schrijfIdentiteit(state, plan.cwd, { naam: plan.name, rol: "agent", lead: plan.env.LAB_LEAD_NAAM!, opdracht: "", spawn_id: spawn, ts: Date.now(), relay_owner: owner });
  });
  let p: ReturnType<typeof Bun.spawn> | undefined;
  const interrupt = () => p?.kill("SIGINT");
  const terminate = () => p?.kill("SIGTERM");
  const hangup = () => p?.kill("SIGHUP");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  process.on("SIGHUP", hangup);
  try {
    p = Bun.spawn([plan.env.LAB_LEAD_BUN!, ...bunArgs(join(ROOT, "src/session-child.ts"), [JSON.stringify({ state, lease: { spawn, name: plan.name, cwd: plan.cwd, vendor, owner }, argv: [executable, ...plan.argv.slice(1)] })])], { cwd: plan.cwd, env: plan.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await p.exited;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    process.off("SIGHUP", hangup);
    // A CLI crash may omit SessionEnd. Retire only records from this exact launch.
    const owned = withLaunchLock(state, (db) => {
      const lease = launchLeases(db).find((lease) => lease.spawn === spawn);
      if (lease && lease.owner.pid !== (p?.pid ?? owner.pid) && lease.owner.pid !== owner.pid) throw new Error("Relay session owner changed unexpectedly; preserving state");
      if (vendor === "codex" && lease) wisLauncherIdentiteit(state, plan.cwd, spawn, lease.owner);
      const records = alleRecords(state).filter((record) => record.spawn_id === spawn && record.toestand !== "weg");
      for (const record of records) schrijfRecord(state, { ...record, toestand: "weg", sinds: Date.now(), einde: Date.now() });
      deleteLaunchLease(db, spawn);
      return records;
    });
    if (owned.length) {
      const bus = standaardBus(plan.env);
      for (const record of owned) await bus.idleGemeld(record.naam, "weg");
      await bus.klaar();
    }
  }
}
