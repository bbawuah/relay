import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { draai, repoWortel } from "./relay";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function nepRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "relay-test-"));
  dirs.push(root);
  return root;
}

function opnemer(uitkomst = 0) {
  const aanroepen: Array<{ argv: string[]; env?: Record<string, string | undefined> }> = [];
  return { aanroepen, run: async (argv: string[], _cwd: string, env?: Record<string, string | undefined>) => (aanroepen.push({ argv, env }), uitkomst) };
}

function schrijfUitvoerbaar(bestand: string, inhoud: string) {
  mkdirSync(path.dirname(bestand), { recursive: true });
  writeFileSync(bestand, inhoud);
  chmodSync(bestand, 0o755);
}

/** Een echte subprocess tegen alleen nep-doelscripts: geen provider, tmux of peers-server. */
function echteRelay(root: string, args: string[], env: Record<string, string> = {}) {
  const relay = path.join(root, "scripts/lead/relay.ts");
  const p = Bun.spawnSync([process.execPath, relay, ...args], {
    cwd: root,
    env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe",
  });
  return { code: p.exitCode, uit: new TextDecoder().decode(p.stdout), fout: new TextDecoder().decode(p.stderr) };
}

function nepRepo() {
  const root = nepRoot();
  const log = path.join(root, "aanroepen.log");
  mkdirSync(path.join(root, "scripts/lead/peers"), { recursive: true });
  cpSync(path.join(import.meta.dir, "relay.ts"), path.join(root, "scripts/lead/relay.ts"));
  const shell = "#!/bin/sh\nprintf '%s:%s\\n' \"$(basename \"$0\")\" \"$*\" >>\"$RELAY_LOG\"\nexit \"${RELAY_EXIT:-0}\"\n";
  schrijfUitvoerbaar(path.join(root, "scripts/lead/spawn.sh"), shell);
  schrijfUitvoerbaar(path.join(root, "scripts/lead/lead-codex-auto.sh"), shell);
  schrijfUitvoerbaar(path.join(root, "scripts/lead/status.sh"), shell);
  writeFileSync(path.join(root, "scripts/lead/peers/cli.ts"), 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.RELAY_LOG!, `cli.ts:${process.argv.slice(2).join(" ")}\\n`); process.exit(Number(process.env.RELAY_EXIT ?? 0));\n');
  const bin = path.join(root, "bin"); mkdirSync(bin);
  schrijfUitvoerbaar(path.join(bin, "claude"), shell);
  schrijfUitvoerbaar(path.join(bin, "gh"), shell);
  return { root, log, env: { RELAY_LOG: log, PATH: `${bin}:${process.env.PATH}`, LAB_AGENT_NAAM: "lead-relay", LAB_LEAD_NAAM: "lead-relay" } };
}

describe("relay", () => {
  test("--help is lokaal en start geen doelprogramma", async () => {
    const n = opnemer();
    expect(await draai(["--help"], { root: nepRoot(), uitvoer: n.run })).toBe(0);
    expect(n.aanroepen).toHaveLength(0);
  });

  test("leidt de wortel alleen uit zijn scriptmap af", () => {
    expect(repoWortel("/tijdelijk/relay/scripts/lead")).toBe("/tijdelijk/relay");
  });

  test("codex -l geeft de bestaande starter ongewijzigd door", async () => {
    const n = opnemer(17); const root = nepRoot();
    expect(await draai(["codex", "-l", "werk door"], { root, uitvoer: n.run })).toBe(17);
    expect(n.aanroepen[0]!.argv).toEqual(["bash", path.join(root, "scripts/lead/lead-codex-auto.sh"), "werk door"]);
  });

  test("codex zonder -l opent dezelfde lead-starter, met optionele prompt", async () => {
    const n = opnemer(); const root = nepRoot();
    expect(await draai(["codex"], { root, uitvoer: n.run })).toBe(0);
    expect(n.aanroepen[0]!.argv).toEqual(["bash", path.join(root, "scripts/lead/lead-codex-auto.sh")]);
    expect(await draai(["codex", "onderzoek dit"], { root, uitvoer: n.run })).toBe(0);
    expect(n.aanroepen[1]!.argv).toEqual(["bash", path.join(root, "scripts/lead/lead-codex-auto.sh"), "onderzoek dit"]);
  });

  test("codex zonder -l houdt vlaggen en meerdere promptdelen tegen", async () => {
    const n = opnemer(); const root = nepRoot();
    expect(await draai(["codex", "eerste", "tweede"], { root, uitvoer: n.run })).toBe(2);
    expect(await draai(["codex", "--netwerk"], { root, uitvoer: n.run })).toBe(2);
    expect(n.aanroepen).toHaveLength(0);
  });

  test("claude -l volgt de gedocumenteerde lead-startregel", async () => {
    const n = opnemer(); const oudNaam = process.env.LAB_AGENT_NAAM; const oudLead = process.env.LAB_LEAD_NAAM;
    process.env.LAB_AGENT_NAAM = process.env.LAB_LEAD_NAAM = "lead-relay";
    try {
      expect(await draai(["claude", "-l"], { root: nepRoot(), uitvoer: n.run })).toBe(0);
      expect(n.aanroepen[0]).toMatchObject({ argv: ["claude", "-n", "lead-relay"], env: { LAB_LEAD: "1", LAB_AGENT_ROL: "lead" } });
    } finally {
      if (oudNaam === undefined) delete process.env.LAB_AGENT_NAAM; else process.env.LAB_AGENT_NAAM = oudNaam;
      if (oudLead === undefined) delete process.env.LAB_LEAD_NAAM; else process.env.LAB_LEAD_NAAM = oudLead;
    }
  });

  test("werkers gaan alleen via spawn met de toegelaten map-vlag", async () => {
    const n = opnemer(); const root = nepRoot();
    await draai(["codex", "-w", "bouwer", "opdracht.md", "--map", "werk"], { root, uitvoer: n.run });
    expect(n.aanroepen[0]!.argv).toEqual(["bash", path.join(root, "scripts/lead/spawn.sh"), "--vendor", "codex", "--naam", "bouwer", "--opdracht", "opdracht.md", "--map", "werk"]);
    expect(await draai(["codex", "-w", "bouwer", "opdracht.md", "--netwerk"], { root, uitvoer: n.run })).toBe(2);
    expect(n.aanroepen).toHaveLength(1);
  });

  test("send gebruikt uitsluitend de peers-CLI", async () => {
    const n = opnemer(); const root = nepRoot();
    await draai(["send", "andere", "bericht"], { root, uitvoer: n.run });
    expect(n.aanroepen[0]!.argv).toEqual([process.execPath, path.join(root, "scripts/lead/peers/cli.ts"), "send", "andere", "bericht"]);
    expect(n.aanroepen[0]!.argv.join(" ")).not.toContain("tmux");
  });

  test("wist preload-omgevingen voor ieder kindproces", async () => {
    const n = opnemer(); const root = nepRoot();
    const oudBun = process.env.BUN_OPTIONS; const oudNode = process.env.NODE_OPTIONS;
    process.env.BUN_OPTIONS = "--preload /tmp/nep-bunfig";
    process.env.NODE_OPTIONS = "--require /tmp/nep-node";
    try {
      await draai(["send", "andere", "bericht"], { root, uitvoer: n.run });
      expect(n.aanroepen[0]!.env?.BUN_OPTIONS).toBeUndefined();
      expect(n.aanroepen[0]!.env?.NODE_OPTIONS).toBeUndefined();
    } finally {
      if (oudBun === undefined) delete process.env.BUN_OPTIONS; else process.env.BUN_OPTIONS = oudBun;
      if (oudNode === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oudNode;
    }
  });

  test("ls en status zijn leesroutes en behouden een weigering", async () => {
    const n = opnemer(); const root = nepRoot();
    await draai(["ls"], { root, uitvoer: n.run });
    expect(n.aanroepen.map((x) => x.argv.slice(1))).toEqual([
      [path.join(root, "scripts/lead/peers/cli.ts"), "list"],
      [path.join(root, "scripts/lead/status.sh"), "--git"],
    ]);
    n.aanroepen.length = 0;
    await draai(["status"], { root, uitvoer: n.run });
    expect(n.aanroepen.map((x) => x.argv[0])).toEqual(["bash", "gh"]);
    expect(n.aanroepen[1]!.argv.slice(1)).toEqual(["pr", "list", "--state", "open", "--limit", "20"]);
    const weigert = opnemer(9);
    expect(await draai(["ls"], { root, uitvoer: weigert.run })).toBe(9);
    expect(weigert.aanroepen).toHaveLength(1);
  });

  test("elke subopdracht draait uitsluitend zijn nep-doelscript en houdt de exitcode", () => {
    const n = nepRepo();
    expect(echteRelay(n.root, ["codex", "-l", "prompt"], n.env).code).toBe(0);
    expect(echteRelay(n.root, ["claude", "-l"], n.env).code).toBe(0);
    expect(echteRelay(n.root, ["claude", "-w", "w1", "taak.md", "--map", "werk"], n.env).code).toBe(0);
    expect(echteRelay(n.root, ["send", "w1", "bericht"], n.env).code).toBe(0);
    expect(echteRelay(n.root, ["ls"], n.env).code).toBe(0);
    expect(echteRelay(n.root, ["status"], n.env).code).toBe(0);
    expect(echteRelay(n.root, ["codex", "-w", "w1", "taak.md"], { ...n.env, RELAY_EXIT: "7" }).code).toBe(7);
    const regels = readFileSync(n.log, "utf8").trim().split("\n");
    expect(regels).toContain("lead-codex-auto.sh:prompt");
    expect(regels).toContain("claude:-n lead-relay");
    expect(regels).toContain("spawn.sh:--vendor claude --naam w1 --opdracht taak.md --map werk");
    expect(regels).toContain("cli.ts:send w1 bericht");
    expect(regels).toContain("cli.ts:list");
    expect(regels).toContain("status.sh:--git");
    expect(regels).toContain("status.sh:--json --git");
    expect(regels).toContain("gh:pr list --state open --limit 20");
    expect(regels.join("\n")).not.toContain("tmux");
  });
});
