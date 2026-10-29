import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { leesRecord, nieuwRecord, schrijfIdentiteit, schrijfRecord } from "../scripts/lead/hooks/register";
import { maakBus } from "../scripts/lead/peers/bus";

const SERVER = resolve(import.meta.dir, "../scripts/lead/peers/server.ts");
const GEBOUNDEN = "01a17ebe-4fe1-79b1-807b-0e8515a20120";
let dir: string;
let cwd: string;
let staat: string;
let env: Record<string, string>;
const bus = () => maakBus({ staat });
const roep = (id: number, name = "inbox", meta?: unknown, args = {}) => ({
  jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
});
const tekst = (r: any): string => r.result.content[0].text;

function identiteit(rol = "agent", gebonden = GEBOUNDEN): void {
  schrijfIdentiteit(staat, cwd, { naam: "codex-peer", rol, lead: "codex-peer", opdracht: "", spawn_id: "test", ts: Date.now(), ...(gebonden ? { sessie_id: gebonden } : {}) });
}

function beschermLead(gebonden = GEBOUNDEN): void {
  identiteit("lead-proef", gebonden);
  schrijfRecord(staat, { ...leesRecord(staat, "id-codex-peer")!, rol: "lead-proef" });
}

function draai(regels: unknown[], extra: Record<string, string> = {}, werkmap = cwd): any[] {
  const p = Bun.spawnSync([process.execPath, SERVER], {
    env: { ...env, ...extra }, cwd: werkmap, stdin: Buffer.from(`${regels.map((r) => JSON.stringify(r)).join("\n")}\n`),
    stdout: "pipe", stderr: "pipe", timeout: 5_000,
  });
  expect(p.stderr.toString()).toBe("");
  expect(p.exitCode).toBe(0);
  return p.stdout.toString().trim().split("\n").filter(Boolean).map((r) => JSON.parse(r));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "relay-mcp-identity-"));
  cwd = join(dir, "checkout");
  staat = join(dir, "state");
  mkdirSync(cwd);
  cwd = realpathSync(cwd);
  mkdirSync(join(dir, "home"));
  // Geen geërfde instellingen, preloads, rollen, vendor-processen of sockets.
  env = { HOME: join(dir, "home"), LAB_LEAD_STAAT: staat, LAB_AGENT_NAAM: "claude-peer" };
  for (const naam of ["zender", "claude-peer", "codex-peer"]) {
    schrijfRecord(staat, { ...nieuwRecord(`id-${naam}`, { LAB_AGENT_NAAM: naam }, cwd, Date.now()), host: "geen", inbound: { standaard: "accept" } });
  }
  identiteit();
  expect((await bus().send("zender", "claude-peer", "alleen voor Claude")).ok).toBe(true);
  expect((await bus().send("zender", "codex-peer", "alleen voor Codex")).ok).toBe(true);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("stdio: expliciete Relay MCP-naam leest en ackt uitsluitend de gevraagde inbox in een Codex-checkout", () => {
  const r = draai([
    { jsonrpc: "2.0", id: 0, method: "initialize", params: {} }, roep(1), roep(2),
  ], { RELAY_MCP_NAME: "claude-peer" });
  expect(r[0].result.serverInfo.name).toBe("peers");
  expect(tekst(r[1])).toContain("alleen voor Claude");
  expect(tekst(r[1])).not.toContain("alleen voor Codex");
  expect(tekst(r[1])).toContain("geen toestemming van Brian");
  expect(tekst(r[2])).toBe("Geen berichten.");
  expect(bus().inbox("claude-peer")).toEqual([]);
  expect(bus().inbox("codex-peer").map((m) => m.tekst)).toEqual(["alleen voor Codex"]);
  expect(existsSync(join(staat, "peers/inbox/codex-peer.gelezen"))).toBe(false);
});

test.each([undefined, "", ".", "..", "../claude-peer", "peer naam", "x".repeat(101)])("stdio: zonder geldige opt-in (%s) blijft de legacy checkout-identiteit gelden", (naam) => {
  const r = draai([roep(1)], naam === undefined ? {} : { RELAY_MCP_NAME: naam });
  expect(tekst(r[0])).toContain("alleen voor Codex");
  expect(tekst(r[0])).not.toContain("alleen voor Claude");
  expect(bus().inbox("codex-peer")).toEqual([]);
  expect(bus().inbox("claude-peer")).toHaveLength(1);
  expect(existsSync(join(staat, "peers/inbox/claude-peer.gelezen"))).toBe(false);
});

test("stdio: expliciete naam bepaalt ook send; ontvangst voegt geen beheertools of rol toe", () => {
  const r = draai([roep(1), roep(2, "send", undefined, { naar: "zender", tekst: "antwoord" }), roep(3, "vrijgeven", undefined, { naam: "zender" })], { RELAY_MCP_NAME: "claude-peer" });
  expect(tekst(r[0])).toContain("alleen voor Claude");
  expect(r[1].result.isError).toBeUndefined();
  expect(bus().inbox("zender")[0]?.van).toBe("claude-peer");
  expect(r[2].error.code).toBe(-32602);
  expect(leesRecord(staat, "id-claude-peer")?.rol).toBe("");
  expect(bus().inbox("codex-peer")).toHaveLength(1);
});

test.each([undefined, {}, { threadId: "andere-sessie" }, { threadId: GEBOUNDEN, sessionId: "ander" }])("stdio: protected opt-in zonder bestaande binding (%j) leest en ackt geen peer", (meta) => {
  beschermLead();
  const r = draai([roep(1, "inbox", meta, { threadId: GEBOUNDEN, _meta: { threadId: GEBOUNDEN } }), roep(2, "send", meta, { naar: "zender", tekst: "verboden" })], { RELAY_MCP_NAME: "CoDeX-PeEr" });
  for (const antwoord of r) expect(antwoord.result.isError).toBe(true);
  expect(bus().inbox("claude-peer")).toHaveLength(1);
  expect(bus().inbox("codex-peer")).toHaveLength(1);
  expect(bus().inbox("zender")).toEqual([]);
  for (const naam of ["claude-peer", "codex-peer"]) expect(existsSync(join(staat, `peers/inbox/${naam}.gelezen`))).toBe(false);
});

test("stdio: protected opt-in met bestaande _meta/cwd-binding werkt", () => {
  beschermLead();
  const r = draai([roep(1, "inbox", { threadId: GEBOUNDEN, sessionId: GEBOUNDEN }), roep(2, "inbox", { sessionId: GEBOUNDEN })], { RELAY_MCP_NAME: "codex-peer" });
  expect(tekst(r[0])).toContain("alleen voor Codex");
  expect(tekst(r[1])).toBe("Geen berichten.");
  expect(bus().inbox("codex-peer")).toEqual([]);
  expect(bus().inbox("claude-peer")).toHaveLength(1);
});

test("stdio: expliciete andere peer wint ook in de werkruimte van een gebonden proeflead", () => {
  beschermLead();
  const r = draai([roep(1, "inbox", { threadId: GEBOUNDEN })], { RELAY_MCP_NAME: "claude-peer" });
  expect(tekst(r[0])).toContain("alleen voor Claude");
  expect(bus().inbox("claude-peer")).toEqual([]);
  expect(bus().inbox("codex-peer")).toHaveLength(1);
});

test("stdio: alleen de workspace-identiteit beschermt de proeflead al, zonder registerrol", () => {
  identiteit("lead-proef");
  const r = draai([roep(1)], { RELAY_MCP_NAME: "CODEX-PEER" });
  expect(r[0].result.isError).toBe(true);
  expect(bus().inbox("codex-peer")).toHaveLength(1);
  expect(bus().inbox("claude-peer")).toHaveLength(1);
});

test("stdio: een register-proeflead is ook vanuit een andere cwd beschermd, zelfs met het juiste _meta-id", () => {
  beschermLead();
  const r = draai([roep(1, "inbox", { threadId: GEBOUNDEN })], { RELAY_MCP_NAME: "codex-peer" }, dir);
  expect(r[0].result.isError).toBe(true);
  expect(bus().inbox("codex-peer")).toHaveLength(1);
  expect(bus().inbox("claude-peer")).toHaveLength(1);
});

test("stdio: een ongebonden proeflead-identiteit blijft beschermd tegen expliciete naam", () => {
  beschermLead("");
  const r = draai([roep(1, "inbox", { threadId: GEBOUNDEN })], { RELAY_MCP_NAME: "codex-peer" });
  expect(r[0].result.isError).toBe(true);
  expect(bus().inbox("codex-peer")).toHaveLength(1);
});

test.each([undefined, "", "../codex-peer"])("stdio: ongeldige opt-in (%s) versoepelt de legacy lead-proef-binding niet", (naam) => {
  beschermLead();
  const { LAB_AGENT_NAAM: _geerfd, ...zonderNaam } = env;
  env = zonderNaam;
  const r = draai([roep(1), roep(2, "inbox", { threadId: GEBOUNDEN })], naam === undefined ? {} : { RELAY_MCP_NAME: naam });
  expect(r[0].result.isError).toBe(true);
  expect(tekst(r[1])).toContain("alleen voor Codex");
  expect(bus().inbox("claude-peer")).toHaveLength(1);
});
