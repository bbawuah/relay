import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seintje, type WekDoel } from "./types";
import { maakWekker, type Run, vindT3 } from "./wekker";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wk-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const basis: WekDoel = { naam: "w", vendor: "claude", host: "tui", toestand: "idle" };
type Aanroep = { cmd: string; args: string[]; env: Record<string, string | undefined> };

function nepRun(antwoorden: ((a: Aanroep) => { code?: number; stdout?: string; stderr?: string; timeout?: boolean }) | undefined = undefined) {
  const calls: Aanroep[] = [];
  const run: Run = async (cmd, args, { env }) => {
    const a = { cmd, args, env };
    calls.push(a);
    const r = antwoorden?.(a) ?? {};
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timeout: r.timeout };
  };
  return { calls, run };
}

describe("claude/tui: socket", () => {
  let server: Server;
  afterEach(() => server?.close());

  test("schrijft één user-regel met alleen seintje(n) naar een echte unix-socket", async () => {
    const pad = join(dir, "s.sock");
    const ontvangen = new Promise<string>((klaar) => {
      server = createServer((c) => {
        let b = "";
        c.on("data", (d) => (b += d));
        c.on("end", () => klaar(b));
      }).listen(pad);
    });
    const w = maakWekker({ env: {} });
    const u = await w.wek({ ...basis, socket: pad }, 3);
    expect(u).toEqual({ gewekt: true, route: "socket" });
    const regel = await ontvangen;
    expect(regel.endsWith("\n")).toBe(true);
    expect(regel.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(regel)).toEqual({ type: "user", message: { role: "user", content: seintje(3) } });
  });

  test("socket bestaat niet: niet gewekt met reden, gooit niet", async () => {
    const u = await maakWekker({ env: {} }).wek({ ...basis, socket: join(dir, "weg.sock") }, 1);
    expect(u.gewekt).toBe(false);
    expect(u.melding).toBeTruthy();
  });

  test("socket die niet sluit: tijdsgrens van de injecteerbare schrijver wordt een melding", async () => {
    const w = maakWekker({ env: {}, socketSchrijf: async () => { throw new Error("socket: tijdsgrens"); } });
    expect(await w.wek({ ...basis, socket: "/x" }, 1)).toEqual({ gewekt: false, route: "fout", melding: "socket: tijdsgrens" });
  });

  test("geen socket in het doel", async () => {
    const u = await maakWekker({ env: {} }).wek(basis, 1);
    expect(u).toMatchObject({ gewekt: false, route: "socket" });
  });
});

describe("codex/tui: codex queue", () => {
  const doel: WekDoel = { ...basis, vendor: "codex", thread_id: "abc-123" };

  test("roept codex queue aan met thread en seintje, CODEX_HOME uit het doel", async () => {
    const { calls, run } = nepRun();
    const u = await maakWekker({ env: { PATH: "/bin", CODEX_HOME: "/oud" }, run }).wek({ ...doel, codex_home: "/tmp/ch" }, 2);
    expect(u).toEqual({ gewekt: true, route: "codex-queue" });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("codex");
    expect(calls[0].args).toEqual(["queue", "--thread", "abc-123", "--message", seintje(2)]);
    expect(calls[0].env.CODEX_HOME).toBe("/tmp/ch");
  });

  test("zonder codex_home blijft de omgeving ongemoeid", async () => {
    const { calls, run } = nepRun();
    await maakWekker({ env: { PATH: "/bin" }, run }).wek(doel, 1);
    expect(calls[0].env.CODEX_HOME).toBeUndefined();
  });

  test("geen thread_id: niet wekken", async () => {
    const { calls, run } = nepRun();
    const u = await maakWekker({ env: {}, run }).wek({ ...doel, thread_id: undefined }, 1);
    expect(u.gewekt).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("exit ≠ 0 en tijdsgrens geven niet gewekt", async () => {
    const a = await maakWekker({ env: {}, run: nepRun(() => ({ code: 1, stderr: "Error: No active session" })).run }).wek(doel, 1);
    expect(a.gewekt).toBe(false);
    expect(a.melding).toContain("No active session");
    const b = await maakWekker({ env: {}, run: nepRun(() => ({ code: null, timeout: true })).run }).wek(doel, 1);
    expect(b).toMatchObject({ gewekt: false, route: "codex-queue" });
  });

  test("een run die gooit (codex ontbreekt) wordt een melding", async () => {
    const run: Run = async () => { throw new Error("ENOENT codex"); };
    expect(await maakWekker({ env: {}, run }).wek(doel, 1)).toEqual({ gewekt: false, route: "fout", melding: "ENOENT codex" });
  });

  test("met een nep-codex in PATH (echt proces)", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf '%s|' "$CODEX_HOME" "$@" > "${log}"\n`);
    chmodSync(join(bin, "codex"), 0o755);
    const u = await maakWekker({ env: { PATH: `${bin}:/usr/bin:/bin` } }).wek({ ...doel, codex_home: "/tmp/h" }, 1);
    expect(u.gewekt).toBe(true);
    expect(readFileSync(log, "utf8")).toBe(`/tmp/h|queue|--thread|abc-123|--message|${seintje(1)}|`);
  });
});

describe("t3", () => {
  const doel: WekDoel = { ...basis, host: "t3", t3_thread: "th1" };
  const env = { LAB_T3: "/nep/t3" };

  test("pendingRequestCount 0: show, daarna send met seintje", async () => {
    const { calls, run } = nepRun((a) => (a.args[1] === "show" ? { stdout: '{"pendingRequestCount":0}' } : {}));
    const u = await maakWekker({ env, run }).wek(doel, 4);
    expect(u).toEqual({ gewekt: true, route: "t3" });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      ["/nep/t3", "thread", "show", "th1", "--json"],
      ["/nep/t3", "thread", "send", "th1", seintje(4)],
    ]);
  });

  test("open vraag, ontbrekend veld of kapotte JSON: niet sturen", async () => {
    for (const stdout of ['{"pendingRequestCount":1}', "{}", "geen json"]) {
      const { calls, run } = nepRun(() => ({ stdout }));
      const u = await maakWekker({ env, run }).wek(doel, 1);
      expect(u.gewekt).toBe(false);
      expect(calls).toHaveLength(1);
    }
  });

  test("show faalt of send faalt", async () => {
    expect((await maakWekker({ env, run: nepRun(() => ({ code: 1 })).run }).wek(doel, 1)).gewekt).toBe(false);
    const run = nepRun((a) => (a.args[1] === "show" ? { stdout: '{"pendingRequestCount":0}' } : { code: 2 })).run;
    expect(await maakWekker({ env, run }).wek(doel, 1)).toMatchObject({ gewekt: false, route: "t3" });
  });

  test("geen t3_thread of geen binary", async () => {
    expect((await maakWekker({ env, run: nepRun().run }).wek({ ...doel, t3_thread: undefined }, 1)).gewekt).toBe(false);
    const u = await maakWekker({ env: { PATH: join(dir, "leeg") }, run: nepRun().run }).wek(doel, 1);
    expect(u.melding).toContain("niet gevonden");
  });

  test("beide vendors gaan via t3", async () => {
    for (const vendor of ["claude", "codex"] as const) {
      const { calls, run } = nepRun((a) => (a.args[1] === "show" ? { stdout: '{"pendingRequestCount":0}' } : {}));
      expect((await maakWekker({ env, run }).wek({ ...doel, vendor }, 1)).route).toBe("t3");
      expect(calls).toHaveLength(2);
    }
  });

  test("met een nep-t3 in PATH (echt proces)", async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const log = join(dir, "log");
    writeFileSync(join(bin, "t3"), `#!/bin/sh\necho "$@" >> "${log}"\n[ "$2" = show ] && echo '{"pendingRequestCount":0}'\nexit 0\n`);
    chmodSync(join(bin, "t3"), 0o755);
    const u = await maakWekker({ env: { PATH: `${bin}:/usr/bin:/bin` } }).wek(doel, 1);
    expect(u.gewekt).toBe(true);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["thread show th1 --json", `thread send th1 ${seintje(1)}`]);
  });
});

describe("vindT3", () => {
  test("LAB_T3 gaat voor, dan PATH, dan de nieuwste runtime-versie", () => {
    expect(vindT3({ LAB_T3: "/x/t3", PATH: "/bin" })).toBe("/x/t3");
    const v = join(dir, ".t3", "runtime", "versions");
    for (const n of ["0.1.2", "0.1.10", "0.1.9"]) {
      mkdirSync(join(v, n), { recursive: true });
      writeFileSync(join(v, n, "t3"), "x");
    }
    expect(vindT3({ HOME: dir, PATH: join(dir, "leeg") })).toBe(join(v, "0.1.10", "t3"));
    mkdirSync(join(dir, "p"));
    writeFileSync(join(dir, "p", "t3"), "x");
    expect(vindT3({ HOME: dir, PATH: join(dir, "p") })).toBe(join(dir, "p", "t3"));
    expect(existsSync(join(dir, "p"))).toBe(true);
  });
  test("niets gevonden", () => {
    expect(vindT3({ HOME: dir, PATH: "" })).toBeNull();
  });
});

describe("acp en onvolledig doel", () => {
  test("acp: niet in fase 1", async () => {
    expect(await maakWekker({ env: {} }).wek({ ...basis, host: "acp" }, 1)).toEqual({ gewekt: false, route: "acp", melding: "niet in fase 1" });
  });
  test("host geen: niet wekken, geen commando", async () => {
    const { calls, run } = nepRun();
    const u = await maakWekker({ env: {}, run }).wek({ ...basis, host: "geen" }, 1);
    expect(u).toMatchObject({ gewekt: false, route: "geen" });
    expect(calls).toHaveLength(0);
  });
});
