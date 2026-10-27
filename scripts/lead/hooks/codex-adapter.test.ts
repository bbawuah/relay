import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herkomstNa, hostVan, leesBron, maaktExtern, peerVelden } from "./codex-adapter";
import { type Opties, verwerk } from "./hook";
import { leesRecord } from "./register";

const FIX = join(import.meta.dir, "codex-fixtures");
const SID = String(JSON.parse(readFileSync(join(FIX, "codex-SessionStart.json"), "utf8")).session_id);
// De fixtures komen uit verschillende proefsessies: ze krijgen hier allemaal het session_id van de SessionStart-fixture.
const fixture = (naam: string): Record<string, unknown> => ({ ...JSON.parse(readFileSync(join(FIX, `codex-${naam}.json`), "utf8")), session_id: SID });

let dir: string;
let staat: string;
let klok: number;
const opt = (): Opties => ({ nu: () => klok, bron: "codex" });
const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: dir,
  LAB_LEAD_STAAT: staat,
  LAB_AGENT_NAAM: "cx1",
  LAB_AGENT_ROL: "agent",
  LAB_LEAD_NAAM: "lead",
  CODEX_HOME: "/tmp/codexhome-x",
  ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-adapter-"));
  staat = join(dir, "staat");
  klok = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("codex-adapter (pure)", () => {
  test("leesBron: --bron codex, de rest blijft over", () => {
    expect(leesBron(["--bron", "codex", "Stop"])).toEqual({ bron: "codex", rest: ["Stop"] });
    expect(leesBron(["wekker"])).toEqual({ bron: "claude", rest: ["wekker"] });
    expect(leesBron(["--bron", "onzin"])).toEqual({ bron: "claude", rest: [] });
  });
  test("peerVelden: codex krijgt thread_id en codex_home, claude de socket, T3 de thread", () => {
    expect(peerVelden("codex", { CODEX_HOME: "/h" }, "t1")).toEqual({ vendor: "codex", host: "tui", herkomst: "schoon", thread_id: "t1", codex_home: "/h" });
    expect(peerVelden("codex", {}, "t1")).toEqual({ vendor: "codex", host: "tui", herkomst: "schoon", thread_id: "t1" });
    expect(peerVelden("claude", { CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock" }, "s")).toEqual({ vendor: "claude", host: "tui", herkomst: "schoon", socket: "/tmp/cc-socks/1.sock" });
    expect(peerVelden("codex", { LAB_T3_THREAD: "mcp:abc" }, "t1")).toMatchObject({ host: "t3", t3_thread: "mcp:abc" });
    expect(hostVan({})).toBe("tui");
  });
  test("maaktExtern: web-tools en MCP buiten peers", () => {
    expect(maaktExtern("WebFetch")).toBe(true);
    expect(maaktExtern("WebSearch")).toBe(true);
    expect(maaktExtern("mcp__github__get_issue")).toBe(true);
    expect(maaktExtern("mcp__peers__send")).toBe(false);
    expect(maaktExtern("mcp__peers__inbox")).toBe(false);
    expect(maaktExtern("Bash")).toBe(false);
    expect(maaktExtern("apply_patch")).toBe(false);
    expect(maaktExtern("SendMessage")).toBe(false);
    expect(herkomstNa("Bash", "extern")).toBe("extern");
    expect(herkomstNa("Bash", undefined)).toBe("schoon");
  });
});

describe("hook.ts met Codex-invoer (echte fixtures uit de spike)", () => {
  test("SessionStart: record met vendor codex, thread_id = session_id, codex_home, host tui, herkomst schoon", async () => {
    await verwerk("SessionStart", fixture("SessionStart"), env(), opt());
    expect(leesRecord(staat, SID)).toMatchObject({ id: SID, naam: "cx1", rol: "agent", lead: "lead", vendor: "codex", host: "tui", thread_id: SID, codex_home: "/tmp/codexhome-x", herkomst: "schoon", toestand: "bezig" });
  });

  test("een hele beurt zonder rapport: Stop blokkeert (de gate blijft aan voor Codex); bij stop_hook_active gaat hij door als idle", async () => {
    const e = env();
    await verwerk("SessionStart", fixture("SessionStart"), e, opt());
    await verwerk("UserPromptSubmit", fixture("UserPromptSubmit"), e, opt());
    await verwerk("PreToolUse", fixture("PreToolUse-Bash"), e, opt());
    await verwerk("PostToolUse", fixture("PostToolUse-Bash"), e, opt());
    await verwerk("PreToolUse", fixture("PreToolUse-apply_patch"), e, opt());
    await verwerk("PostToolUse", fixture("PostToolUse-apply_patch"), e, opt());
    expect(leesRecord(staat, SID)).toMatchObject({ tools_in_beurt: 2, laatste_tool: "apply_patch" });
    const stop = await verwerk("Stop", fixture("Stop"), e, opt());
    expect(JSON.parse(stop.stdout).decision).toBe("block");
    const door = await verwerk("Stop", { ...fixture("Stop"), stop_hook_active: true }, e, opt());
    expect(door.stdout).toBe("");
    expect(leesRecord(staat, SID)?.toestand).toBe("idle");
    await verwerk("SessionEnd", fixture("SessionEnd"), e, opt());
    expect(leesRecord(staat, SID)?.toestand).toBe("weg");
  });

  test("rapport-gate: peers.send naar de eigen lead telt als rapport (klaar); naar een ander niet", async () => {
    const e = env();
    await verwerk("SessionStart", fixture("SessionStart"), e, opt());
    await verwerk("PreToolUse", fixture("PreToolUse-Bash"), e, opt());
    const send = (naar: string, tekst: string) => ({ ...fixture("PostToolUse-Bash"), tool_name: "mcp__peers__send", tool_input: { naar, tekst } });
    await verwerk("PostToolUse", send("iemand-anders", "hoi"), e, opt());
    expect(leesRecord(staat, SID)?.rapport_in_beurt).toBe(false);
    await verwerk("PostToolUse", send("lead", "PR 1, groen"), e, opt());
    expect(leesRecord(staat, SID)).toMatchObject({ rapport_in_beurt: true, rapport_om: klok, vrij: false });
    const stop = await verwerk("Stop", fixture("Stop"), e, opt());
    expect(stop.stdout).toBe("");
    expect(leesRecord(staat, SID)?.toestand).toBe("klaar");
  });

  test("rapport met slotregel vrij zet vrij; de tekst zelf wordt nergens bewaard", async () => {
    const e = env();
    await verwerk("SessionStart", fixture("SessionStart"), e, opt());
    await verwerk("PreToolUse", fixture("PreToolUse-Bash"), e, opt());
    await verwerk("PostToolUse", { ...fixture("PostToolUse-Bash"), tool_name: "mcp__peers__send", tool_input: { naar: "lead", tekst: "GEHEIME-INHOUD\nvrij" } }, e, opt());
    const stop = await verwerk("Stop", fixture("Stop"), e, opt());
    expect(stop.stdout).toBe("");
    const ruw = readFileSync(join(staat, "register", `${SID}.json`), "utf8");
    expect(ruw).not.toContain("GEHEIME-INHOUD");
    expect(JSON.parse(ruw).toestand).toBe("vrij");
  });

  test("een lead telt zijn eigen peers.send niet als rapport", async () => {
    const e = env({ LAB_AGENT_ROL: "lead", LAB_AGENT_NAAM: "lead", LAB_LEAD_NAAM: "" });
    await verwerk("SessionStart", fixture("SessionStart"), e, opt());
    await verwerk("PostToolUse", { ...fixture("PostToolUse-Bash"), tool_name: "mcp__peers__send", tool_input: { naar: "lead", tekst: "x" } }, e, opt());
    expect(leesRecord(staat, SID)?.rapport_in_beurt).toBe(false);
  });

  test("herkomst: WebFetch of een MCP buiten peers maakt extern; peers-tools niet; SessionStart (ook /clear) zet terug op schoon", async () => {
    const e = env();
    await verwerk("SessionStart", fixture("SessionStart"), e, opt());
    await verwerk("PostToolUse", { ...fixture("PostToolUse-Bash"), tool_name: "mcp__peers__inbox", tool_input: {} }, e, opt());
    expect(leesRecord(staat, SID)?.herkomst).toBe("schoon");
    await verwerk("PostToolUse", { ...fixture("PostToolUse-Bash"), tool_name: "mcp__github__get_issue", tool_input: {} }, e, opt());
    expect(leesRecord(staat, SID)?.herkomst).toBe("extern");
    await verwerk("PostToolUse", { ...fixture("PostToolUse-Bash") }, e, opt());
    expect(leesRecord(staat, SID)?.herkomst).toBe("extern");
    await verwerk("SessionStart", { ...fixture("SessionStart"), source: "clear" }, e, opt());
    expect(leesRecord(staat, SID)?.herkomst).toBe("schoon");
  });

  test("Claude: SendMessage blijft rapport; peers.send ook; WebSearch maakt extern; socket komt in het record", async () => {
    const e = env({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/9.sock" });
    const o: Opties = { nu: () => klok };
    await verwerk("SessionStart", { session_id: "c1", cwd: "/w" }, e, o);
    expect(leesRecord(staat, "c1")).toMatchObject({ vendor: "claude", host: "tui", socket: "/tmp/cc-socks/9.sock", herkomst: "schoon" });
    expect(leesRecord(staat, "c1")?.thread_id).toBeUndefined();
    await verwerk("PostToolUse", { session_id: "c1", cwd: "/w", tool_name: "SendMessage", tool_input: { to: "lead", message: "klaar" } }, e, o);
    expect(leesRecord(staat, "c1")?.rapport_in_beurt).toBe(true);
    await verwerk("UserPromptSubmit", { session_id: "c1", cwd: "/w" }, e, o);
    await verwerk("PostToolUse", { session_id: "c1", cwd: "/w", tool_name: "mcp__peers__send", tool_input: { naar: "lead", tekst: "ok" } }, e, o);
    expect(leesRecord(staat, "c1")?.rapport_in_beurt).toBe(true);
    await verwerk("PostToolUse", { session_id: "c1", cwd: "/w", tool_name: "WebSearch", tool_input: {} }, e, o);
    expect(leesRecord(staat, "c1")?.herkomst).toBe("extern");
  });

  test("een inbound-keuze in het record overleeft een nieuwe SessionStart", async () => {
    const e = env();
    await verwerk("SessionStart", fixture("SessionStart"), e, opt());
    const pad = join(staat, "register", `${SID}.json`);
    const r = JSON.parse(readFileSync(pad, "utf8"));
    await Bun.write(pad, JSON.stringify({ ...r, inbound: { standaard: "refuse" } }));
    await verwerk("SessionStart", { ...fixture("SessionStart"), source: "resume" }, e, opt());
    expect(leesRecord(staat, SID)?.inbound).toEqual({ standaard: "refuse" });
  });
});
