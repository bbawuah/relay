import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seintje, type WekDoel } from "./types";
import { echteRun, maakWekker, type Run, vindT3 } from "./wekker";

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
  const sockPad = (naam = "123.sock") => {
    mkdirSync(join(dir, "cc-socks"), { recursive: true });
    return join(dir, "cc-socks", naam);
  };
  const env = () => ({ TMPDIR: dir });

  test("schrijft één user-regel met alleen seintje(n) naar een echte unix-socket", async () => {
    const pad = sockPad();
    const ontvangen = new Promise<string>((klaar) => {
      server = createServer((c) => {
        let b = "";
        c.on("data", (d) => (b += d));
        c.on("end", () => klaar(b));
      }).listen(pad);
    });
    const w = maakWekker({ env: env() });
    const u = await w.wek({ ...basis, socket: pad }, 3);
    expect(u).toEqual({ gewekt: true, route: "socket" });
    const regel = await ontvangen;
    expect(regel.endsWith("\n")).toBe(true);
    expect(regel.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(regel)).toEqual({ type: "user", message: { role: "user", content: seintje(3) } });
  });

  test("socket bestaat niet: niet gewekt met reden, gooit niet", async () => {
    const u = await maakWekker({ env: env() }).wek({ ...basis, socket: sockPad("9.sock") }, 1);
    expect(u.gewekt).toBe(false);
    expect(u.melding).toBeTruthy();
  });

  test("weigert paden buiten cc-socks/<cijfers>.sock, een symlink naar elders en een gewoon bestand", async () => {
    const geschreven: string[] = [];
    const w = maakWekker({ env: env(), socketSchrijf: async (p) => void geschreven.push(p) });
    const echt = sockPad("5.sock");
    server = createServer().listen(echt);
    await new Promise((k) => server.once("listening", k));
    writeFileSync(join(dir, "6.sock"), "x");
    writeFileSync(sockPad("7.sock"), "x");
    symlinkSync(echt, join(dir, "8.sock"));
    mkdirSync(join(dir, "cc-socks", "sub"));
    symlinkSync(join(dir, "6.sock"), sockPad("10.sock"));
    for (const pad of [join(dir, "6.sock"), join(dir, "8.sock"), sockPad("7.sock"), sockPad("10.sock"), sockPad("abc.sock"), join(dir, "cc-socks", "sub"), "/etc/passwd"]) {
      const u = await w.wek({ ...basis, socket: pad }, 1);
      expect(u).toMatchObject({ gewekt: false, route: "socket" });
    }
    expect(geschreven).toEqual([]);
    expect((await w.wek({ ...basis, socket: echt }, 1)).gewekt).toBe(true);
    expect(geschreven).toHaveLength(1);
  });

  test("socket die niet sluit: tijdsgrens van de injecteerbare schrijver wordt een melding", async () => {
    const echt = sockPad("11.sock");
    server = createServer().listen(echt);
    await new Promise((k) => server.once("listening", k));
    const w = maakWekker({ env: env(), socketSchrijf: async () => { throw new Error("socket: tijdsgrens"); } });
    expect(await w.wek({ ...basis, socket: echt }, 1)).toEqual({ gewekt: false, route: "fout", melding: "socket: tijdsgrens" });
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
    const u = await maakWekker({ env: { PATH: "/bin", HOME: "/h", CODEX_HOME: "/oud", LAB_AGENT_NAAM: "x", CLAUDE_CODE_MESSAGING_SOCKET: "/s" }, run }).wek({ ...doel, codex_home: "/tmp/ch" }, 2);
    expect(u).toEqual({ gewekt: true, route: "codex-queue" });
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("codex");
    expect(calls[0].args).toEqual(["queue", "--thread=abc-123", "--message", seintje(2)]);
    expect(calls[0].env).toEqual({ PATH: "/bin", HOME: "/h", CODEX_HOME: "/tmp/ch" });
  });

  test("zonder codex_home van het doel wordt de CODEX_HOME van de afzender niet doorgegeven", async () => {
    const { calls, run } = nepRun();
    await maakWekker({ env: { PATH: "/bin", CODEX_HOME: "/afzender" }, run }).wek(doel, 1);
    expect(calls[0].env.CODEX_HOME).toBeUndefined();
  });

  test("een thread_id die als vlag leest of rare tekens heeft wordt niet gebruikt", async () => {
    for (const id of ["--help", "-x", "a b", "a;b", "", "../x"]) {
      const { calls, run } = nepRun();
      const u = await maakWekker({ env: {}, run }).wek({ ...doel, thread_id: id }, 1);
      expect(u.gewekt).toBe(false);
      expect(calls).toHaveLength(0);
    }
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
    const b = await maakWekker({ env: {}, run: nepRun(() => ({ code: 137, timeout: true })).run }).wek(doel, 1);
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
    expect(readFileSync(log, "utf8")).toBe(`/tmp/h|queue|--thread=abc-123|--message|${seintje(1)}|`);
  });
});

describe("t3", () => {
  const doel: WekDoel = { ...basis, host: "t3", t3_thread: "mcp:th1" };
  let env: { LAB_T3: string; PATH?: string; HOME?: string };
  beforeEach(() => {
    const bin = join(dir, "nept3");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    env = { LAB_T3: bin };
  });

  test("pendingRequestCount 0: show, daarna send met seintje", async () => {
    const { calls, run } = nepRun((a) => (a.args[1] === "show" ? { stdout: '{"pendingRequestCount":0}' } : {}));
    const u = await maakWekker({ env, run }).wek(doel, 4);
    expect(u).toEqual({ gewekt: true, route: "t3" });
    expect(calls.map((c) => [c.cmd, ...c.args])).toEqual([
      [env.LAB_T3, "thread", "show", "mcp:th1", "--json"],
      [env.LAB_T3, "thread", "send", "mcp:th1", seintje(4)],
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
    const u = await maakWekker({ env: { PATH: join(dir, "leeg"), HOME: dir }, run: nepRun().run }).wek(doel, 1);
    expect(u.melding).toContain("niet gevonden");
  });

  test("een t3_thread die als vlag leest wordt niet gebruikt", async () => {
    const { calls, run } = nepRun();
    expect((await maakWekker({ env, run }).wek({ ...doel, t3_thread: "--json" }, 1)).gewekt).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("show en send delen één budget van 10 s; de omgeving van het kind is beperkt", async () => {
    let klok = 0;
    const { calls, run } = nepRun((a) => {
      if (a.args[1] === "show") klok += 6_000;
      return a.args[1] === "show" ? { stdout: '{"pendingRequestCount":0}' } : {};
    });
    const timeouts: number[] = [];
    const run2: Run = async (c, a, o) => (timeouts.push(o.timeoutMs), run(c, a, o));
    const u = await maakWekker({ env: { ...env, PATH: "/bin", HOME: "/h", T3CODE_HOME: "/t", LAB_AGENT_NAAM: "x", CODEX_HOME: "/c" }, run: run2, nu: () => klok }).wek(doel, 1);
    expect(u.gewekt).toBe(true);
    expect(timeouts).toEqual([10_000, 4_000]);
    expect(calls[0].env).toEqual({ PATH: "/bin", HOME: "/h", T3CODE_HOME: "/t" });
  });

  test("budget op na show: niet sturen", async () => {
    let klok = 0;
    const { calls, run } = nepRun(() => ((klok += 10_000), { stdout: '{"pendingRequestCount":0}' }));
    const u = await maakWekker({ env, run, nu: () => klok }).wek(doel, 1);
    expect(u.gewekt).toBe(false);
    expect(calls).toHaveLength(1);
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
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["thread show mcp:th1 --json", `thread send mcp:th1 ${seintje(1)}`]);
  });
});

describe("vindT3", () => {
  test("LAB_T3 gaat voor, dan PATH, dan de nieuwste runtime-versie", () => {
    const eigen = join(dir, "eigen-t3");
    writeFileSync(eigen, "x");
    expect(vindT3({ LAB_T3: eigen, PATH: "/bin" })).toBeNull(); // niet uitvoerbaar
    chmodSync(eigen, 0o755);
    expect(vindT3({ LAB_T3: eigen, PATH: "/bin" })).toBe(eigen);
    const v = join(dir, ".t3", "runtime", "versions");
    for (const n of ["0.1.2", "0.1.10", "0.1.9"]) {
      mkdirSync(join(v, n), { recursive: true });
      writeFileSync(join(v, n, "t3"), "x", { mode: 0o755 });
    }
    expect(vindT3({ HOME: dir, PATH: join(dir, "leeg") })).toBe(join(v, "0.1.10", "t3"));
    mkdirSync(join(dir, "p"));
    writeFileSync(join(dir, "p", "t3"), "x");
    expect(vindT3({ HOME: dir, PATH: join(dir, "p") })).toBe(join(v, "0.1.10", "t3")); // PATH-t3 niet uitvoerbaar: overslaan
    chmodSync(join(dir, "p", "t3"), 0o755);
    expect(vindT3({ HOME: dir, PATH: join(dir, "p") })).toBe(join(dir, "p", "t3"));
    expect(existsSync(join(dir, "p"))).toBe(true);
  });
  test("niets gevonden", () => {
    expect(vindT3({ HOME: dir, PATH: "" })).toBeNull();
  });
});

describe("echteRun: tijdsgrens", () => {
  const maak = (naam: string, inhoud: string) => {
    const p = join(dir, naam);
    writeFileSync(p, `#!/bin/sh\n${inhoud}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  const o = (timeoutMs: number) => ({ env: { PATH: "/usr/bin:/bin" }, timeoutMs });

  // echte-klok: de tijdsgrens van een echt kindproces is het onderwerp van deze tests
  test("een kind dat SIGTERM negeert, komt na de tijdsgrens terug met timeout", async () => {
    const t0 = Date.now();
    const r = await echteRun(maak("negeer", 'trap "" TERM\nsleep 4'), [], o(300));
    expect(r.timeout).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  test("een kleinkind dat de pipes openhoudt, houdt een afgesloten kind niet op", async () => {
    const t0 = Date.now();
    const r = await echteRun(maak("klein", "sleep 4 &\necho uit\nexit 0"), [], o(5_000));
    expect(Date.now() - t0).toBeLessThan(1_500); // niet de 5 s tijdsgrens afwachten
    expect(r.stdout).toBe("uit\n");
    expect(r.code).toBe(0);
    expect(r.timeout).toBe(false);
  });

  test("een kind dat wacht op een kleinkind: timeout en de groep gaat eruit", async () => {
    const pidbestand = join(dir, "pid");
    const t0 = Date.now();
    const r = await echteRun(maak("wacht", `sleep 30 &\necho $! > ${pidbestand}\nwait`), [], o(300));
    expect(r.timeout).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2_000);
    const pid = Number(readFileSync(pidbestand, "utf8"));
    await Bun.sleep(400); // echte-klok: wachten tot SIGKILL de groep heeft opgeruimd
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("normale uitvoer en exitcode komen terug", async () => {
    const r = await echteRun(maak("ok", 'echo uit; echo fout >&2; exit 3'), [], o(5_000));
    expect(r).toEqual({ code: 3, stdout: "uit\n", stderr: "fout\n", timeout: false });
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
