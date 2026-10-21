import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Akkoord, challenge, type Ctx, MAPPEN, soort, type Uitslag, type Verzoek, verzoekHash, zorgVoorMappen } from "@lab-bawuah/lab-commando";
import { controleerMappen, KLOK_MARGE_S, leesSleutels, LIVE_ARGV0, MAX_AKKOORD_S, runnerCtx, valideerAkkoord, valideerSleutels, verwerk, verwerkAlles, type Opties, type Sleutels } from "./runner";
import { maakAuthenticator, sleutelsVoor, type Authenticator } from "./webauthn-proef";
import { maakCtx } from "../vraag-brian";

// De runner in een wegwerpmap: tijdelijke LAB_COMMANDO, LAB_COMMANDO_KLOON en LAB_LEAD_STAAT, sleutelparen
// uit crypto.subtle, nep-binaries (bash, git, Tailscale, echo) in een eigen map. Nooit de echte tailscale,
// een git-remote of ~/.local/state. De klok is een vaste `nu`: 21 okt 2026 12:00 in Amsterdam.

const NU = Date.parse("2026-10-21T10:00:00Z");
const ORIGIN = "http://localhost:8399";
const RPID = "localhost";
const ENV_SLEUTELS = ["LAB_COMMANDO", "LAB_COMMANDO_KLOON", "LAB_LEAD_STAAT", "TMUX_PWA_LIVE"] as const;
let oudeEnv: Record<string, string | undefined>;
let dir: string;
let map: string;
let nepBin: string;
let log: string;
let auth: Authenticator;
let sleutels: Sleutels;
let ctx: Ctx;
let teller = 0;

const lees = (p: string) => readFileSync(p, "utf8");
const uitslag = (id: string): Uitslag => JSON.parse(lees(join(map, MAPPEN.uitslag, `${id}.json`)));
const inbox = (lead = "lead-proef") => {
  const p = join(dir, "staat", "inbox", `${lead}.jsonl`);
  return existsSync(p) ? lees(p).trim().split("\n").map((r) => JSON.parse(r) as { t: number; van: string; tekst: string }) : [];
};
const aanroepen = () => (existsSync(log) ? lees(log).trim().split("\n") : []);

function nep(naam: string, script: string) {
  writeFileSync(join(nepBin, naam), `#!/bin/sh\necho "${naam} $*" >> "${log}"\n${script}\n`);
  chmodSync(join(nepBin, naam), 0o755);
}

function verzoek(over: Partial<Verzoek> = {}): Verzoek {
  teller++;
  return {
    versie: 1,
    id: `proef-${teller}`,
    soort: "proef-echo",
    params: { tekst: "hallo" },
    waarom: "test",
    door: "cm-runner",
    lead: "lead-proef",
    tijd: new Date(NU - 60_000).toISOString(),
    verlooptS: Math.floor(NU / 1000) + 3600,
    ...over,
  };
}

type Leg = {
  /** Wat de runner op schijf vindt (standaard het getekende verzoek). */
  opSchijf?: Verzoek;
  ctxBijTekenen?: Ctx;
  hashInChallenge?: string;
  verlooptS?: number;
  teken?: Partial<Parameters<Authenticator["teken"]>[0]>;
  door?: Authenticator;
  akkoord?: Partial<Akkoord>;
};

/** Legt een verzoek en een akkoord neer zoals de server dat doet: met een assertion over challenge(id, hash, …). */
async function leg(v: Verzoek, o: Leg = {}): Promise<Akkoord> {
  const hash = verzoekHash(v, o.ctxBijTekenen ?? ctx);
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
  const verlooptS = o.verlooptS ?? Math.floor(NU / 1000) + 300;
  const assertion = await (o.door ?? auth).teken({
    challenge: challenge(v.id, o.hashInChallenge ?? hash, nonce, verlooptS),
    origin: ORIGIN,
    rpID: RPID,
    ...o.teken,
  });
  const a: Akkoord = { versie: 1, id: v.id, hash, nonce, verlooptS, apparaat: "iphone-proef", tijd: new Date(NU).toISOString(), assertion, ...o.akkoord };
  writeFileSync(join(map, MAPPEN.verzoeken, `${v.id}.json`), JSON.stringify(o.opSchijf ?? v), { mode: 0o600 });
  writeFileSync(join(map, MAPPEN.akkoord, `${v.id}.json`), JSON.stringify(a), { mode: 0o600 });
  return a;
}

const logregels: string[] = [];
const opties = (over: Partial<Opties> = {}): Opties => ({ map, ctx, sleutels, nu: () => NU, log: (r) => logregels.push(r), ...over });

beforeEach(async () => {
  logregels.length = 0;
  oudeEnv = Object.fromEntries(ENV_SLEUTELS.map((k) => [k, process.env[k]]));
  dir = realpathSync(mkdtempSync(join(tmpdir(), "commando-runner-")));
  map = join(dir, "commando");
  nepBin = join(dir, "bin");
  log = join(dir, "aanroepen.log");
  mkdirSync(nepBin);
  mkdirSync(join(dir, "kloon"));
  process.env.LAB_COMMANDO = map;
  process.env.LAB_COMMANDO_KLOON = join(dir, "kloon");
  process.env.LAB_LEAD_STAAT = join(dir, "staat");
  delete process.env.TMUX_PWA_LIVE;
  zorgVoorMappen(map);
  ctx = runnerCtx(false);
  auth = await maakAuthenticator();
  sleutels = sleutelsVoor([auth], RPID, [ORIGIN]);
});
afterEach(() => {
  for (const k of ENV_SLEUTELS) if (oudeEnv[k] === undefined) delete process.env[k];
  else process.env[k] = oudeEnv[k];
  rmSync(dir, { recursive: true, force: true });
});

describe("runner: een geldig akkoord", () => {
  test("draait één keer: uitslag klaar, log, grootboek, inbox, geen claim over", async () => {
    const v = verzoek();
    await leg(v);
    const [u] = await verwerkAlles(opties());
    expect(u).toMatchObject({ id: v.id, stand: "klaar", exit: 0, staart: ["hallo"] });
    expect(uitslag(v.id).stand).toBe("klaar");
    expect(lees(join(map, MAPPEN.uitvoer, `${v.id}.log`))).toBe("hallo\n");
    expect(existsSync(join(map, MAPPEN.gebruikt, v.id))).toBe(true);
    expect(existsSync(join(map, MAPPEN.akkoord, `${v.id}.json`))).toBe(false);
    expect(await verwerkAlles(opties())).toEqual([]);
    const regels = inbox();
    expect(regels).toHaveLength(1);
    expect(regels[0]!.van).toBe("commando-runner");
    expect(regels[0]!.tekst).toContain(`commando proef-echo ${v.id}: klaar exit 0`);
    expect(regels[0]!.tekst).toContain(`vraag-brian.ts lees ${v.id}`);
    expect(Buffer.byteLength(JSON.stringify(regels[0]))).toBeLessThan(512);
  });

  test("tweemaal tegelijk claimen geeft één run", async () => {
    const v = verzoek();
    await leg(v);
    let runs = 0;
    const spawn: Opties["spawn"] = async () => {
      runs++;
      return { exit: 0, uitvoer: "ok\n" };
    };
    const uit = await Promise.all([verwerk(v.id, opties({ spawn })), verwerk(v.id, opties({ spawn }))]);
    expect(uit.filter(Boolean)).toHaveLength(1);
    expect(runs).toBe(1);
  });

  test("replay: hetzelfde akkoord opnieuw neergelegd draait niet nog eens", async () => {
    const v = verzoek();
    const a = await leg(v);
    await verwerkAlles(opties());
    writeFileSync(join(map, MAPPEN.akkoord, `${v.id}.json`), JSON.stringify(a));
    let runs = 0;
    expect(await verwerk(v.id, opties({ spawn: async () => (runs++, { exit: 0, uitvoer: "" }) }))).toBeNull();
    expect(runs).toBe(0);
    expect(uitslag(v.id).stand).toBe("klaar");
  });

  test("replay: met een bestaande uitslag (bv. geweigerd) draait niets en blijft de uitslag staan", async () => {
    const v = verzoek();
    await leg(v);
    const geweigerd: Uitslag = { versie: 1, id: v.id, stand: "geweigerd", staart: [], tijd: new Date(NU).toISOString() };
    writeFileSync(join(map, MAPPEN.uitslag, `${v.id}.json`), JSON.stringify(geweigerd));
    expect(await verwerk(v.id, opties())).toBeNull();
    expect(uitslag(v.id)).toEqual(geweigerd);
    expect(existsSync(join(map, MAPPEN.gebruikt, v.id))).toBe(false);
  });

  test("replay: de id staat al in het grootboek", async () => {
    const v = verzoek();
    await leg(v);
    writeFileSync(join(map, MAPPEN.gebruikt, v.id), "eerder\n");
    expect(await verwerk(v.id, opties())).toBeNull();
    expect(existsSync(join(map, MAPPEN.uitslag, `${v.id}.json`))).toBe(false);
  });
});

/** Elke afwijzing: uitslag fout (of verlopen) met de reden, en er draait niets. */
async function afgewezen(id: string, reden: RegExp, o: Partial<Opties> = {}, stand: Uitslag["stand"] = "fout") {
  let runs = 0;
  const u = await verwerk(id, opties({ spawn: async () => (runs++, { exit: 0, uitvoer: "" }), ...o }));
  expect(runs).toBe(0);
  expect(u?.stand).toBe(stand);
  expect(u?.reden ?? "").toMatch(reden);
  expect(u && "staart" in u).toBe(true);
  expect(uitslag(id).stand).toBe(stand);
  expect(existsSync(join(map, MAPPEN.gebruikt, id))).toBe(false);
  expect(existsSync(join(map, MAPPEN.akkoord, `${id}.json`))).toBe(false);
}

/**
 * Onbewezen (niet van Brian): geen eindstand, het verzoek blijft open, het akkoord is weg, er draait niets,
 * een logregel en de marker gebruikt/<id>.afgewezen.
 */
async function onbewezen(id: string, reden: RegExp, o: Partial<Opties> = {}) {
  let runs = 0;
  const u = await verwerk(id, opties({ spawn: async () => (runs++, { exit: 0, uitvoer: "" }), ...o }));
  expect(runs).toBe(0);
  expect(u?.stand).toBe("onbewezen");
  expect(u?.reden ?? "").toMatch(reden);
  expect(existsSync(join(map, MAPPEN.uitslag, `${id}.json`))).toBe(false);
  expect(existsSync(join(map, MAPPEN.gebruikt, id))).toBe(false);
  expect(existsSync(join(map, MAPPEN.gebruikt, `${id}.afgewezen`))).toBe(true);
  expect(existsSync(join(map, MAPPEN.akkoord, `${id}.json`))).toBe(false);
  expect(logregels.some((r) => r.includes(`${id} onbewezen`))).toBe(true);
}

describe("runner: kanaries, elke afwijzing apart", () => {
  test("akkoord verlopen", async () => {
    const v = verzoek();
    await leg(v, { verlooptS: Math.floor(NU / 1000) });
    await afgewezen(v.id, /akkoord verlopen/, {}, "verlopen");
  });
  test("akkoord geldt te lang (niet door de server gemaakt)", async () => {
    const v = verzoek();
    await leg(v, { verlooptS: Math.floor(NU / 1000) + 3600 });
    await afgewezen(v.id, /te lang/);
  });
  test("verzoek verlopen", async () => {
    const v = verzoek({ verlooptS: Math.floor(NU / 1000) - 1 });
    await leg(v);
    await afgewezen(v.id, /verzoek verlopen/, {}, "verlopen");
  });
  test("params gewijzigd na het akkoord", async () => {
    const v = verzoek();
    await leg(v, { opSchijf: { ...v, params: { tekst: "anders" } } });
    await onbewezen(v.id, /gewijzigd/);
  });
  test("lead gewijzigd na het akkoord", async () => {
    const v = verzoek();
    await leg(v, { opSchijf: { ...v, lead: "andere-lead" } });
    await onbewezen(v.id, /gewijzigd/);
  });
  test("argv-sjabloon gewijzigd na het akkoord (andere clone, dus andere cwd)", async () => {
    const v = verzoek({ soort: "tak-weg", params: { tak: "lead/x" } });
    await leg(v, { ctxBijTekenen: { ...ctx, kloon: "/elders" } });
    await onbewezen(v.id, /gewijzigd/, { nepBin });
  });
  test("akkoord.hash klopt, maar de handtekening is over een andere hash", async () => {
    const v = verzoek();
    await leg(v, { hashInChallenge: "0".repeat(64) });
    await onbewezen(v.id, /handtekening/);
  });
  test("een andere sleutel (onbekende passkey)", async () => {
    const v = verzoek();
    await leg(v, { door: await maakAuthenticator() });
    await onbewezen(v.id, /onbekende passkey/);
  });
  test("een andere sleutel onder de credential-id van Brian", async () => {
    const v = verzoek();
    const ander = await maakAuthenticator();
    const a = await leg(v, { door: ander });
    writeFileSync(join(map, MAPPEN.akkoord, `${v.id}.json`), JSON.stringify({ ...a, assertion: { ...a.assertion, credentialId: auth.credentialId } }));
    await onbewezen(v.id, /handtekening/);
  });
  test("UV uit (geen Face ID)", async () => {
    const v = verzoek();
    await leg(v, { teken: { uv: false } });
    await onbewezen(v.id, /handtekening|UV/i);
  });
  test("UP uit", async () => {
    const v = verzoek();
    await leg(v, { teken: { up: false } });
    await onbewezen(v.id, /handtekening/);
  });
  test("verkeerde origin", async () => {
    const v = verzoek();
    await leg(v, { teken: { origin: "https://kwaad.example" } });
    await onbewezen(v.id, /handtekening/);
  });
  test("verkeerde rpID", async () => {
    const v = verzoek();
    await leg(v, { teken: { rpID: "kwaad.example" } });
    await onbewezen(v.id, /handtekening/);
  });
  test("type webauthn.create in plaats van get", async () => {
    const v = verzoek();
    await leg(v, { teken: { type: "webauthn.create" } });
    await onbewezen(v.id, /handtekening/);
  });
  test("akkoord met een extra sleutel", async () => {
    const v = verzoek();
    const a = await leg(v);
    writeFileSync(join(map, MAPPEN.akkoord, `${v.id}.json`), JSON.stringify({ ...a, argv: ["sh", "-c", "id"] }));
    await onbewezen(v.id, /onbekende sleutel argv/);
  });
  test("id in het akkoord hoort niet bij de bestandsnaam", async () => {
    const v = verzoek();
    const a = await leg(v);
    const w = verzoek();
    await leg(w);
    writeFileSync(join(map, MAPPEN.akkoord, `${w.id}.json`), JSON.stringify(a));
    await onbewezen(w.id, /hoort niet bij de bestandsnaam/);
  });
  test("het akkoord is een symlink", async () => {
    const v = verzoek();
    await leg(v);
    const p = join(map, MAPPEN.akkoord, `${v.id}.json`);
    renameSync(p, join(dir, "echt.json"));
    symlinkSync(join(dir, "echt.json"), p);
    await onbewezen(v.id, /symlink/);
  });
  test("het verzoek is een symlink", async () => {
    const v = verzoek();
    await leg(v);
    const p = join(map, MAPPEN.verzoeken, `${v.id}.json`);
    renameSync(p, join(dir, "echt.json"));
    symlinkSync(join(dir, "echt.json"), p);
    await onbewezen(v.id, /symlink/);
  });
  test("een map is een symlink of te ruim: de runner begint niet", () => {
    const akk = join(map, MAPPEN.akkoord);
    rmSync(akk, { recursive: true });
    mkdirSync(join(dir, "ander"), { mode: 0o700 });
    symlinkSync(join(dir, "ander"), akk);
    expect(() => controleerMappen(map)).toThrow(/geen gewone map/);
    rmSync(akk);
    mkdirSync(akk, { mode: 0o700 });
    chmodSync(akk, 0o755);
    expect(() => controleerMappen(map)).toThrow(/modus 755/);
  });
  test("onbekende soort (uitrol bestaat nog niet)", async () => {
    const v = verzoek({ soort: "uitrol", params: { sha: "abc" } });
    const a = await leg({ ...verzoek(), id: v.id });
    writeFileSync(join(map, MAPPEN.verzoeken, `${v.id}.json`), JSON.stringify(v));
    writeFileSync(join(map, MAPPEN.akkoord, `${v.id}.json`), JSON.stringify(a));
    await onbewezen(v.id, /onbekende soort/);
  });
  test("proef-echo bestaat live niet", async () => {
    const v = verzoek();
    await leg(v);
    await onbewezen(v.id, /onbekende soort proef-echo/, { ctx: runnerCtx(true) });
  });
  test("param die niet bij de soort past (main weghalen)", async () => {
    const v = verzoek({ soort: "tak-weg", params: { tak: "main" } });
    const a = await leg({ ...verzoek(), id: v.id });
    writeFileSync(join(map, MAPPEN.verzoeken, `${v.id}.json`), JSON.stringify(v));
    writeFileSync(join(map, MAPPEN.akkoord, `${v.id}.json`), JSON.stringify(a));
    await onbewezen(v.id, /main en master/, { nepBin });
  });
  test("stiltevenster bij een zware soort", async () => {
    const s = soort("proef-echo", ctx)!;
    const was = s.zwaar;
    s.zwaar = true; // fase 1 heeft nog geen zware soort; proef-echo speelt er even een
    try {
      const t = Date.parse("2026-10-21T04:00:00Z"); // 06:00 in Amsterdam
      const v = verzoek();
      await leg(v, { verlooptS: t / 1000 + 300 });
      await afgewezen(v.id, /stiltevenster/, { nu: () => t });
    } finally {
      s.zwaar = was;
    }
  });
  test("buiten het stiltevenster en niet zwaar: om 06:00 draait een lichte soort wel", async () => {
    const t = Date.parse("2026-10-21T04:00:00Z"); // 06:00 in Amsterdam
    const v = verzoek();
    await leg(v, { verlooptS: t / 1000 + 300 });
    expect((await verwerk(v.id, opties({ nu: () => t })))?.stand).toBe("klaar");
  });
  test("nonce gewijzigd na het tekenen", async () => {
    const v = verzoek();
    await leg(v, { akkoord: { nonce: "QW5kZXJlTm9uY2U" } });
    await onbewezen(v.id, /handtekening/);
  });
  test("verlooptS gewijzigd na het tekenen", async () => {
    const v = verzoek();
    await leg(v, { akkoord: { verlooptS: Math.floor(NU / 1000) + 290 } });
    await onbewezen(v.id, /handtekening/);
  });
  test("akkoord geldig tot precies 5 min plus de klokmarge: draait; een seconde langer: te lang", async () => {
    const grens = Math.floor(NU / 1000) + MAX_AKKOORD_S + KLOK_MARGE_S;
    expect(MAX_AKKOORD_S + KLOK_MARGE_S).toBe(330);
    const v = verzoek();
    await leg(v, { verlooptS: grens });
    expect((await verwerk(v.id, opties()))?.stand).toBe("klaar");
    const w = verzoek();
    await leg(w, { verlooptS: grens + 1 });
    await afgewezen(w.id, /te lang/);
  });
  test("een bewezen afwijzing komt bij de lead aan", async () => {
    const v = verzoek();
    await leg(v, { verlooptS: Math.floor(NU / 1000) });
    await verwerk(v.id, opties());
    expect(inbox()[0]!.tekst).toMatch(new RegExp(`commando proef-echo ${v.id}: verlopen`));
  });
  test("een onbewezen akkoord: hooguit één inbox-regel per verzoek, het verzoek blijft open", async () => {
    const v = verzoek();
    const a = await leg(v, { teken: { uv: false } });
    await verwerk(v.id, opties());
    writeFileSync(join(map, MAPPEN.akkoord, `${v.id}.json`), JSON.stringify(a));
    expect((await verwerk(v.id, opties()))?.stand).toBe("onbewezen");
    const regels = inbox();
    expect(regels).toHaveLength(1);
    expect(regels[0]!.tekst).toMatch(new RegExp(`commando proef-echo ${v.id}: akkoord niet bewezen.*staat nog open`));
    expect(existsSync(join(map, MAPPEN.verzoeken, `${v.id}.json`))).toBe(true);
    // Brian keurt daarna echt goed: dat draait gewoon
    await leg(v);
    expect((await verwerk(v.id, opties()))?.stand).toBe("klaar");
  });
  test("maxPerDag: telt per soort over 24 uur uit het grootboek; afgewezen, oud en een andere soort tellen niet", async () => {
    const max = soort("proef-echo", ctx)!.maxPerDag;
    const g = join(map, MAPPEN.gebruikt);
    for (let i = 0; i < max - 1; i++) writeFileSync(join(g, `eerder-${i}`), `${new Date(NU - 3_600_000).toISOString()} proef-echo\n`);
    for (let i = 0; i < 5; i++) writeFileSync(join(g, `oud-${i}`), `${new Date(NU - 25 * 3_600_000).toISOString()} proef-echo\n`);
    for (let i = 0; i < 5; i++) writeFileSync(join(g, `ander-${i}`), `${new Date(NU - 60_000).toISOString()} tailnet-dicht\n`);
    for (let i = 0; i < 5; i++) writeFileSync(join(g, `kwaad-${i}.afgewezen`), "");
    const v = verzoek();
    await leg(v);
    expect((await verwerk(v.id, opties()))?.stand).toBe("klaar");
    expect(lees(join(g, v.id))).toBe(`${new Date(NU).toISOString()} proef-echo\n`);
    const w = verzoek();
    await leg(w);
    await afgewezen(w.id, /maxPerDag/);
  });
});

describe("runner: test-stand raakt nooit een echte binary", () => {
  test("tak-weg zonder --nep-bin weigert", async () => {
    const v = verzoek({ soort: "tak-weg", params: { tak: "lead/x" } });
    await leg(v);
    await afgewezen(v.id, /zonder --nep-bin/);
  });
  test("tak-weg in test-stand: push.sh --verwijder met een nep-bash, niets anders in de clone", async () => {
    nep("bash", 'echo "push: remote tak $3 verwijderd"; echo "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"');
    const v = verzoek({ soort: "tak-weg", params: { tak: "lead/x" } });
    await leg(v);
    const u = (await verwerk(v.id, opties({ nepBin }))) as Uitslag;
    expect(u).toMatchObject({ stand: "klaar", exit: 0 });
    expect(aanroepen()).toEqual(["bash scripts/lead/push.sh --verwijder lead/x"]);
    expect(u.staart[0]).toBe("push: remote tak lead/x verwijderd");
    expect(u.staart.join("\n")).not.toContain("ghp_");
    expect(lees(join(map, MAPPEN.uitvoer, `${v.id}.log`))).not.toContain("ghp_");
    expect(JSON.stringify(inbox())).not.toContain("ghp_");
  });
  test("tailnet-open: een bezette https-poort wordt niet overschreven", async () => {
    nep("Tailscale", `[ "$2" = status ] && echo '{"TCP":{"8450":{"HTTPS":true}},"Web":{"mini.ts.net:8450":{}}}'; exit 0`);
    const v = verzoek({ soort: "tailnet-open", params: { https: "8450", app: "5173" } });
    await leg(v);
    const u = await verwerk(v.id, opties({ nepBin }));
    expect(u).toMatchObject({ stand: "fout" });
    expect(u!.reden).toMatch(/8450 staat al in tailscale serve/);
    expect(aanroepen()).toEqual(["Tailscale serve status --json"]);
  });
  test("tailnet-open: een vrije poort gaat open", async () => {
    nep("Tailscale", `[ "$2" = status ] && echo '{"TCP":{"443":{"HTTPS":true}}}'; exit 0`);
    const v = verzoek({ soort: "tailnet-open", params: { https: "8450", app: "5173" } });
    await leg(v);
    expect(await verwerk(v.id, opties({ nepBin }))).toMatchObject({ stand: "klaar", exit: 0 });
    expect(aanroepen()).toEqual(["Tailscale serve status --json", "Tailscale serve --bg --https=8450 http://127.0.0.1:5173"]);
  });
  test("tailnet-open: een onleesbare status faalt dicht", async () => {
    nep("Tailscale", `[ "$2" = status ] && echo 'geen json'; exit 0`);
    const v = verzoek({ soort: "tailnet-open", params: { https: "8450", app: "5173" } });
    await leg(v);
    expect((await verwerk(v.id, opties({ nepBin })))?.reden).toMatch(/geen JSON/);
    expect(aanroepen()).toHaveLength(1);
  });
  test("tailnet-dicht en een exitcode die niet 0 is: fout met exit en staart", async () => {
    nep("Tailscale", "echo 'serve: geen regel op 8450' >&2; exit 3");
    const v = verzoek({ soort: "tailnet-dicht", params: { https: "8450" } });
    await leg(v);
    expect(await verwerk(v.id, opties({ nepBin }))).toMatchObject({ stand: "fout", exit: 3, staart: ["serve: geen regel op 8450"] });
  });
  test("een nep-binary die ontbreekt: fout, er draait niets", async () => {
    const v = verzoek({ soort: "tailnet-dicht", params: { https: "8450" } });
    await leg(v);
    await afgewezen(v.id, /nep-binary Tailscale ontbreekt/, { nepBin });
  });
  test("timeout: het proces wordt gestopt en de uitslag is fout", async () => {
    nep("Tailscale", "exec /bin/sleep 5");
    const v = verzoek({ soort: "tailnet-dicht", params: { https: "8450" } });
    await leg(v);
    // echte-klok: de timeout van Bun.spawn en SIGKILL op een echt proces; 150 ms, de test wacht niet op de sleep
    const u = await verwerk(v.id, opties({ nepBin, timeoutMs: 150 }));
    expect(u?.stand).toBe("fout");
    expect(u?.reden).toMatch(/gestopt met SIG/);
  });
  test("een kleinkind houdt stdout open na de exit: de runner stopt met lezen en blijft niet hangen", async () => {
    const pidBestand = join(dir, "kleinkind.pid");
    nep("Tailscale", `/bin/sleep 30 & echo $! > "${pidBestand}"; echo dicht`);
    const v = verzoek({ soort: "tailnet-dicht", params: { https: "8450" } });
    await leg(v);
    const t0 = performance.now();
    try {
      // echte-klok: een echt kleinkind met een open pipe; naExitMs 100, de test wacht niet op de sleep van 30 s
      const u = (await verwerk(v.id, opties({ nepBin, naExitMs: 100 }))) as Uitslag;
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect(u).toMatchObject({ stand: "klaar", exit: 0 });
      expect(u.staart).toContain("dicht");
      expect(u.staart.join("\n")).toMatch(/pipe bleef open/);
    } finally {
      if (existsSync(pidBestand)) process.kill(Number(lees(pidBestand).trim()));
    }
  });
  test("een binary die niet start (ENOENT): uitslag fout, geen hangende bezig", async () => {
    const v = verzoek();
    await leg(v);
    const u = await verwerk(v.id, opties({ spawn: async () => { throw new Error("spawn ENOENT"); } }));
    expect(u).toMatchObject({ stand: "fout", reden: "starten mislukt: spawn ENOENT" });
    expect(uitslag(v.id).stand).toBe("fout");
  });
  test("een nep-binary zonder uitvoerrecht (echte spawn): fout, en verwerkAlles gaat door met de volgende", async () => {
    writeFileSync(join(nepBin, "echo"), "#!/bin/sh\necho hoi\n", { mode: 0o644 });
    const v = verzoek();
    await leg(v);
    const w = verzoek();
    await leg(w);
    const uit = await verwerkAlles(opties({ nepBin }));
    expect(uit.map((u) => u.stand)).toEqual(["fout", "fout"]);
    expect(uit[0]!.reden).toMatch(/starten mislukt/);
  });
  test("een fout buiten de uitvoering stopt verwerkAlles niet", async () => {
    const v = verzoek();
    await leg(v, { teken: { uv: false } });
    const w = verzoek();
    await leg(w);
    let eerste = true;
    const log = (r: string) => {
      if (eerste) {
        eerste = false;
        throw new Error("log stuk");
      }
      logregels.push(r);
    };
    const uit = await verwerkAlles(opties({ log }));
    expect(uit.map((u) => `${u.id} ${u.stand}`)).toEqual([`${w.id} klaar`]);
    expect(logregels.some((r) => r.includes(`${v.id}: log stuk`))).toBe(true);
  });
});

describe("runner live (fase 1): alleen tailscale met een vast pad, niets uit de clone", () => {
  const live = () => runnerCtx(true);
  test("tak-weg draait live niet (bestaat live niet), en er draait niets", async () => {
    const v = verzoek({ soort: "tak-weg", params: { tak: "lead/x" } });
    await leg(v); // getekend met de hash uit test-stand; live kent de soort niet eens
    let runs = 0;
    const u = await verwerk(v.id, opties({ ctx: live(), spawn: async () => (runs++, { exit: 0, uitvoer: "" }) }));
    expect(runs).toBe(0);
    expect(u).toMatchObject({ stand: "onbewezen", reden: "onbekende soort tak-weg" });
    expect(existsSync(join(map, MAPPEN.gebruikt, v.id))).toBe(false);
  });
  test("een soort die live bestaat maar niet het vaste tailscale-pad draait, weigert live", async () => {
    const s = soort("tailnet-dicht", live())!;
    const was = s.argv;
    s.argv = (p) => ["/bin/sh", "-c", `echo ${p.https}`]; // speelt even een soort met een ander argv[0]
    try {
      const v = verzoek({ soort: "tailnet-dicht", params: { https: "8450" } });
      await leg(v, { ctxBijTekenen: live() });
      await afgewezen(v.id, /niet live/, { ctx: live() });
    } finally {
      s.argv = was;
    }
  });
  test("tailnet-open en -dicht: argv[0] is het vaste tailscale-pad, cwd /, nooit de clone (nep-spawner)", async () => {
    const gezien: { argv: string[]; cwd: string }[] = [];
    const spawn: Opties["spawn"] = async (argv, o) => (gezien.push({ argv, cwd: o.cwd }), { exit: 0, uitvoer: argv[2] === "status" ? "{}" : "" });
    const open = verzoek({ soort: "tailnet-open", params: { https: "8450", app: "5173" } });
    const dicht = verzoek({ soort: "tailnet-dicht", params: { https: "8450" } });
    await leg(open, { ctxBijTekenen: live() });
    await leg(dicht, { ctxBijTekenen: live() });
    expect(await verwerk(open.id, opties({ ctx: live(), spawn }))).toMatchObject({ stand: "klaar" });
    expect(await verwerk(dicht.id, opties({ ctx: live(), spawn }))).toMatchObject({ stand: "klaar" });
    expect(gezien).toHaveLength(3);
    for (const g of gezien) {
      expect(LIVE_ARGV0).toContain(g.argv[0]!);
      expect(g.argv[0]!.startsWith("/")).toBe(true);
      expect(g.cwd).toBe("/");
    }
  });
});

describe("runner: Ctx gelijk aan die van de server", () => {
  test("live server (TMUX_PWA_LIVE=1) = runner --live, anders test-stand", () => {
    expect(runnerCtx(true)).toEqual(maakCtx({ TMUX_PWA_LIVE: "1" }));
    expect(runnerCtx(false)).toEqual(maakCtx({}));
    expect(runnerCtx(true).test).toBe(false);
    const v = verzoek({ soort: "tailnet-dicht", params: { https: "8450" } });
    expect(verzoekHash(v, runnerCtx(true))).toBe(verzoekHash(v, maakCtx({ TMUX_PWA_LIVE: "1" })));
    expect(verzoekHash(v, runnerCtx(false))).toBe(verzoekHash(v, maakCtx({})));
  });
});

describe("passkeys.pub en akkoord: strikt lezen", () => {
  const goed = (): Sleutels => sleutelsVoor([{ credentialId: "abc", publicKey: "def" } as Authenticator], "mini.tail1234.ts.net", ["https://mini.tail1234.ts.net"]);
  test("goed formaat gaat door", () => {
    expect(valideerSleutels(goed())).toEqual(goed());
  });
  test("extra sleutel, http-origin buiten localhost, lege lijst of geen base64url: weigert", () => {
    expect(() => valideerSleutels({ ...goed(), privateKey: "x" })).toThrow(/onbekende sleutel/);
    expect(() => valideerSleutels({ ...goed(), origins: ["http://mini.ts.net"] })).toThrow(/origin/);
    expect(() => valideerSleutels({ ...goed(), sleutels: [] })).toThrow(/sleutels ongeldig/);
    expect(() => valideerSleutels({ ...goed(), sleutels: [{ credentialId: "a b", publicKey: "x" }] })).toThrow(/credentialId/);
  });
  test("live: het bestand moet root-eigen en niet schrijfbaar voor anderen zijn", () => {
    const p = join(dir, "pub", "passkeys.pub");
    mkdirSync(join(dir, "pub"), { mode: 0o755 });
    writeFileSync(p, JSON.stringify(goed()), { mode: 0o644 });
    const uid = process.getuid!();
    // de voorouders (tmp) zijn niet van deze uid, dus met eigenaar = uid faalt het al op de map erboven of eerder
    expect(() => leesSleutels(p, uid + 1)).toThrow(/eigenaar uid/);
    expect(leesSleutels(p, null)).toEqual(goed());
    chmodSync(p, 0o666);
    expect(() => leesSleutels(p, uid)).toThrow(/schrijfbaar|eigenaar/);
    rmSync(p);
    symlinkSync(join(dir, "elders"), p);
    expect(() => leesSleutels(p, uid)).toThrow(/symlink/);
  });
  test("akkoord: een assertion met een extra veld of een id met een hoofdletter weigert", async () => {
    const v = verzoek();
    const a = await leg(v);
    expect(valideerAkkoord(a)).toEqual(a);
    expect(() => valideerAkkoord({ ...a, assertion: { ...a.assertion, extra: "x" } })).toThrow(/onbekende sleutel extra/);
    expect(() => valideerAkkoord({ ...a, id: "Proef" })).toThrow(/id ongeldig/);
    expect(() => valideerAkkoord({ ...a, verlooptS: "1" })).toThrow(/verlooptS/);
  });
});

describe("runner-CLI", () => {
  // HOME telt mee in de hash (env van de soort); alleen de test op de echte map krijgt een andere HOME.
  const cli = (...args: string[]) => cliMet({}, ...args);
  const cliMet = (env: Record<string, string>, ...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "runner.ts"), ...args], {
      env: { ...process.env, LAB_COMMANDO: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, uit: p.stdout.toString(), err: p.stderr.toString() };
  };
  test("test-stand: verwerkt een akkoord in de tijdelijke map", async () => {
    const v = verzoek({ verlooptS: Math.floor(Date.now() / 1000) + 3600, tijd: new Date().toISOString() });
    const sl = join(dir, "sleutels.json");
    writeFileSync(sl, JSON.stringify(sleutels));
    await leg(v, { verlooptS: Math.floor(Date.now() / 1000) + 300 });
    const r = cli("--map", map, "--sleutels", sl, "--eenmaal");
    expect(r.err).toBe("");
    expect(r.uit.trim()).toBe(`${v.id} klaar exit 0`);
  });
  test("de gebundelde runner (zoals in /usr/local/lib/lab-lead) verwerkt een akkoord en controleert de handtekening", async () => {
    const bundel = join(dir, "commando-runner.js");
    const b = Bun.spawnSync(["bun", "build", join(import.meta.dir, "runner.ts"), "--target=bun", "--outfile", bundel], { stdout: "pipe", stderr: "pipe" });
    expect(b.exitCode).toBe(0);
    const sl = join(dir, "sleutels.json");
    writeFileSync(sl, JSON.stringify(sleutels));
    const nuS = Math.floor(Date.now() / 1000);
    const goed = verzoek({ verlooptS: nuS + 3600, tijd: new Date().toISOString() });
    const kwaad = verzoek({ verlooptS: nuS + 3600, tijd: new Date().toISOString() });
    await leg(goed, { verlooptS: nuS + 300 });
    await leg(kwaad, { verlooptS: nuS + 300, teken: { uv: false } });
    const p = Bun.spawnSync(["bun", bundel, "--map", map, "--sleutels", sl], { env: { ...process.env, LAB_COMMANDO: "" }, stdout: "pipe", stderr: "pipe" });
    expect(p.stderr.toString().trim()).toMatch(new RegExp(`^commando-runner: ${kwaad.id} onbewezen, niets uitgevoerd: (handtekening|geen gebruikersverificatie)`));
    const uit = p.stdout.toString().trim().split("\n");
    expect(uit).toHaveLength(2);
    expect(uit).toContain(`${goed.id} klaar exit 0`);
    expect(uit.find((r) => r.startsWith(`${kwaad.id} `))).toMatch(/ onbewezen \((handtekening|geen gebruikersverificatie)/);
  });
  test("een kapotte passkeys.pub: de runner stopt en raakt geen akkoord aan", async () => {
    const v = verzoek({ verlooptS: Math.floor(Date.now() / 1000) + 3600, tijd: new Date().toISOString() });
    await leg(v, { verlooptS: Math.floor(Date.now() / 1000) + 300 });
    const sl = join(dir, "sleutels.json");
    for (const inhoud of ["{", JSON.stringify({ ...sleutels, sleutels: [] }), JSON.stringify({ ...sleutels, extra: 1 })]) {
      writeFileSync(sl, inhoud);
      const r = cli("--map", map, "--sleutels", sl);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/^commando-runner: /);
      expect(r.uit).toBe("");
      expect(existsSync(join(map, MAPPEN.akkoord, `${v.id}.json`))).toBe(true);
    }
  });
  test("test-stand op de echte map weigert", () => {
    const r = cliMet({ HOME: dir }, "--map", join(dir, ".local/state/lab-commando"), "--sleutels", join(dir, "x"));
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/echte map/);
    expect(existsSync(join(dir, ".local/state/lab-commando"))).toBe(false);
  });
  test("--live neemt geen --map of --sleutels; onbekende optie; zonder --live geen standaardpaden", () => {
    expect(cli("--live", "--map", map).err).toMatch(/--live neemt geen/);
    expect(cli("--vrij").err).toMatch(/onbekende optie --vrij/);
    expect(cli("--map", map).err).toMatch(/--map en --sleutels verplicht/);
  });
});
