#!/usr/bin/env bun
// Commando-runner (PLAN §2.5): voert een verzoek uit dat Brian in Terminal B met een passkey goedkeurde.
// Draait als LaunchAgent nl.lab-b.commando (WatchPaths op akkoord/), als root-eigen bundel in
// /usr/local/lib/lab-lead/commando-runner.js. Elke start verwerkt wat er in akkoord/ ligt en stopt.
//
//   bun commando-runner.js --live                                 de echte map, sleutels uit SLEUTELS_PAD
//   bun scripts/lead/commando/runner.ts --map <tmp> --sleutels <json> [--nep-bin <map>] [--eenmaal]
//                                                                 test-stand (Ctx.test = true), alleen tijdelijke paden
//
// De runner vertrouwt niets van de tmux-server: hij leest het verzoek zelf, leidt argv, cwd en env
// zelf af, rekent de hash zelf uit en controleert de WebAuthn-handtekening tegen passkeys.pub (root-eigen,
// alleen publieke sleutels). Zonder geldige handtekening van Brian over precies dit verzoek draait er niets.
// Nooit een shell: argv gaat rechtstreeks naar Bun.spawn. Live (fase 1) draait alleen tailscale met een
// vast absoluut pad en cwd /; niets uit de clone of een andere map die een agent kan wijzigen.
//
// passkeys.pub (beheerd door de runner, zie INSTALLEREN.md):
//   {"versie":1,"rpID":"<host>","origins":["https://<host>"],"sleutels":[{"credentialId":"<b64url>","publicKey":"<b64url COSE>","apparaat"?:"…"}]}

import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from "@simplewebauthn/server";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  afgeleid,
  type Akkoord,
  challenge,
  commandoMap,
  type Ctx,
  inboxRegel,
  kloonPad,
  leesGewoonBestand,
  MAPPEN,
  redigeer,
  schrijfAtomair,
  type Soort,
  soort as zoekSoort,
  staart,
  stilteReden,
  testStand,
  type Uitslag,
  valideerVerzoek,
  type Verzoek,
  verzoekHash,
  zorgVoorMappen,
} from "@lab-bawuah/lab-commando";

export const SLEUTELS_PAD = "/usr/local/lib/lab-lead/passkeys.pub";
/** Een akkoord geldt 5 min (B4); wat verder in de toekomst ligt, heeft de server niet gemaakt. */
export const MAX_AKKOORD_S = 5 * 60;
/** Speling voor een klok die iets voorloopt. */
export const KLOK_MARGE_S = 30;
export const MAX_UITVOER = 64 * 1024;
export const UITVOER_DAGEN = 7;
/** Hooguit zoveel akkoorden per start; de rest komt bij de volgende start (WatchPaths). */
export const MAX_PER_RUN = 20;
const VAN = "commando-runner";
const ID = /^[a-z0-9-]{3,64}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

export interface Sleutel { credentialId: string; publicKey: string; apparaat?: string }
export interface Sleutels { versie: 1; rpID: string; origins: string[]; sleutels: Sleutel[] }

/**
 * Ctx van de runner. --live is altijd live (test=false), wat de omgeving ook zegt. Zonder --live weigert
 * de CLI tenzij testStand(env) (LAB_COMMANDO_TEST=1, zonder TMUX_PWA_LIVE): gelijk aan de server.
 */
export function runnerCtx(live: boolean): Ctx {
  return { kloon: kloonPad(), test: !live };
}

function exact(x: unknown, sleutels: string[], optioneel: string[], wat: string): Record<string, unknown> {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`${wat}: geen object`);
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!sleutels.includes(k) && !optioneel.includes(k)) throw new Error(`${wat}: onbekende sleutel ${k}`);
  for (const k of sleutels) if (!(k in o)) throw new Error(`${wat}: ${k} ontbreekt`);
  return o;
}
const tekst = (o: Record<string, unknown>, k: string, re: RegExp, wat: string, max = 4096): string => {
  const v = o[k];
  if (typeof v !== "string" || v.length > max || !re.test(v)) throw new Error(`${wat}: ${k} ongeldig`);
  return v;
};

/** Strikt: alleen de velden uit de interface, base64url waar het hoort. */
export function valideerAkkoord(x: unknown): Akkoord {
  const o = exact(x, ["versie", "id", "hash", "nonce", "verlooptS", "apparaat", "tijd", "assertion"], [], "akkoord");
  if (o.versie !== 1) throw new Error("akkoord: versie is geen 1");
  if (!Number.isSafeInteger(o.verlooptS)) throw new Error("akkoord: verlooptS is geen geheel getal");
  const a = exact(o.assertion, ["credentialId", "authenticatorData", "clientDataJSON", "signature"], ["userHandle"], "assertion");
  const assertion: Akkoord["assertion"] = {
    credentialId: tekst(a, "credentialId", B64URL, "assertion", 1024),
    authenticatorData: tekst(a, "authenticatorData", B64URL, "assertion"),
    clientDataJSON: tekst(a, "clientDataJSON", B64URL, "assertion"),
    signature: tekst(a, "signature", B64URL, "assertion", 1024),
    ...(a.userHandle === undefined ? {} : { userHandle: tekst(a, "userHandle", B64URL, "assertion", 1024) }),
  };
  return {
    versie: 1,
    id: tekst(o, "id", ID, "akkoord"),
    hash: tekst(o, "hash", /^[0-9a-f]{64}$/, "akkoord"),
    nonce: tekst(o, "nonce", B64URL, "akkoord", 256),
    verlooptS: o.verlooptS as number,
    apparaat: tekst(o, "apparaat", /^[\x21-\x7e]{1,128}$/, "akkoord"),
    tijd: tekst(o, "tijd", /^[0-9T:.Z+-]{10,40}$/, "akkoord"),
    assertion,
  };
}

/** Strikt: versie 1, één rpID, origins als https (of http://localhost voor tests), sleutels in base64url. */
export function valideerSleutels(x: unknown): Sleutels {
  const o = exact(x, ["versie", "rpID", "origins", "sleutels"], [], "passkeys.pub");
  if (o.versie !== 1) throw new Error("passkeys.pub: versie is geen 1");
  const rpID = tekst(o, "rpID", /^[a-z0-9.-]{1,253}$/, "passkeys.pub");
  if (!Array.isArray(o.origins) || o.origins.length === 0 || o.origins.length > 8) throw new Error("passkeys.pub: origins ongeldig");
  const origins = o.origins.map((v) => {
    if (typeof v !== "string" || !/^(https:\/\/[a-z0-9.-]+|http:\/\/localhost)(:\d{1,5})?$/.test(v)) throw new Error(`passkeys.pub: origin ${String(v)} ongeldig`);
    return v;
  });
  if (!Array.isArray(o.sleutels) || o.sleutels.length === 0 || o.sleutels.length > 20) throw new Error("passkeys.pub: sleutels ongeldig");
  const sleutels = o.sleutels.map((s) => {
    const k = exact(s, ["credentialId", "publicKey"], ["apparaat"], "sleutel");
    return {
      credentialId: tekst(k, "credentialId", B64URL, "sleutel", 1024),
      publicKey: tekst(k, "publicKey", B64URL, "sleutel", 1024),
      ...(k.apparaat === undefined ? {} : { apparaat: tekst(k, "apparaat", /^[\x20-\x7e]{1,64}$/, "sleutel") }),
    };
  });
  return { versie: 1, rpID, origins, sleutels };
}

/**
 * Leest passkeys.pub. Live (eigenaar 0) moet het bestand en elke map erboven root-eigen zijn en niet
 * schrijfbaar voor groep of anderen: anders kan een agent zijn eigen sleutel erin zetten.
 */
export function leesSleutels(pad: string, eigenaar: number | null): Sleutels {
  if (eigenaar !== null) {
    for (let p = pad; ; p = path.dirname(p)) {
      const s = lstatSync(p);
      if (s.isSymbolicLink()) throw new Error(`${p} is een symlink`);
      if (s.uid !== eigenaar) throw new Error(`${p}: eigenaar uid ${s.uid}, verwacht ${eigenaar}`);
      if (s.mode & 0o022) throw new Error(`${p}: schrijfbaar voor groep of anderen`);
      if (p === "/") break;
    }
  }
  return valideerSleutels(JSON.parse(leesGewoonBestand(pad)));
}

/**
 * Controleert de WebAuthn-assertion tegen de challenge over precies dit verzoek.
 * Geeft null als alles klopt, anders de reden. UV is verplicht (Face ID of Touch ID: een mens).
 */
export async function controleerHandtekening(a: Akkoord, verwachteChallenge: string, sleutels: Sleutels): Promise<string | null> {
  const k = sleutels.sleutels.find((s) => s.credentialId === a.assertion.credentialId);
  if (!k) return "onbekende passkey";
  const response: AuthenticationResponseJSON = {
    id: a.assertion.credentialId,
    rawId: a.assertion.credentialId,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      authenticatorData: a.assertion.authenticatorData,
      clientDataJSON: a.assertion.clientDataJSON,
      signature: a.assertion.signature,
      ...(a.assertion.userHandle === undefined ? {} : { userHandle: a.assertion.userHandle }),
    },
  };
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: verwachteChallenge,
      expectedOrigin: sleutels.origins,
      expectedRPID: sleutels.rpID,
      expectedType: "webauthn.get",
      // Geen tellerstand: replay vangen de eenmalige nonce, het grootboek in gebruikt/ en de vervaltijd.
      credential: { id: k.credentialId, publicKey: new Uint8Array(Buffer.from(k.publicKey, "base64url")), counter: 0 },
      requireUserVerification: true,
    });
    if (!v.verified) return "handtekening niet geverifieerd";
    if (!v.authenticationInfo.userVerified) return "geen gebruikersverificatie (UV)";
    return null;
  } catch (e) {
    return `handtekening: ${(e as Error).message.slice(0, 200)}`;
  }
}

export interface Uitvoering { exit: number | null; uitvoer: string; reden?: string }
export type Spawner = (argv: string[], o: { cwd: string; env: Record<string, string>; timeoutMs: number; naExitMs?: number }) => Promise<Uitvoering>;

/** Leest een stroom begrensd. `stop` breekt het lezen af (een kleinkind kan de pipe openhouden). */
function leesBegrensd(stroom: ReadableStream<Uint8Array> | null, max: number): { klaar: Promise<{ tekst: string; afgekapt: boolean }>; stop: () => void } {
  if (!stroom) return { klaar: Promise.resolve({ tekst: "", afgekapt: false }), stop: () => {} };
  const lezer = stroom.getReader();
  const delen: Uint8Array[] = [];
  let n = 0;
  let afgekapt = false;
  const klaar = (async () => {
    try {
      for (;;) {
        const { done, value } = await lezer.read();
        if (done) break;
        if (n >= max) {
          afgekapt = true;
          continue; // doorlezen, anders blokkeert het proces op een volle pipe
        }
        const neem = value.subarray(0, max - n);
        if (neem.length < value.length) afgekapt = true;
        delen.push(neem);
        n += neem.length;
      }
    } catch {
      // afgebroken met stop(): wat er is, telt
    }
    return { tekst: Buffer.concat(delen).toString("utf8"), afgekapt };
  })();
  return { klaar, stop: () => void lezer.cancel().catch(() => {}) };
}

/** Na de exit van het proces wacht de runner hooguit zo lang op de pipes. */
export const NA_EXIT_MS = 2000;

/**
 * Echte uitvoering: geen shell, stdin dicht, vaste env, timeout per soort, uitvoer begrensd. Houdt een
 * kleinkind stdout of stderr open na de exit, dan stopt het lezen na naExitMs: de runner blijft nooit hangen.
 */
export const echteSpawner: Spawner = async (argv, o) => {
  const p = Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: o.timeoutMs, killSignal: "SIGKILL" });
  const lezers = [leesBegrensd(p.stdout, MAX_UITVOER), leesBegrensd(p.stderr, MAX_UITVOER)];
  const exit = await p.exited;
  let open = false;
  let klok: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((r) => {
    klok = setTimeout(() => {
      open = true;
      for (const l of lezers) l.stop();
      r();
    }, o.naExitMs ?? NA_EXIT_MS);
  });
  await Promise.race([Promise.all(lezers.map((l) => l.klaar)), deadline]);
  clearTimeout(klok);
  const [uit, err] = await Promise.all(lezers.map((l) => l.klaar));
  let uitvoer = uit!.tekst + (err!.tekst ? (uit!.tekst && !uit!.tekst.endsWith("\n") ? "\n" : "") + err!.tekst : "");
  if (uitvoer.length > MAX_UITVOER) uitvoer = uitvoer.slice(0, MAX_UITVOER);
  if (uit!.afgekapt || err!.afgekapt) uitvoer += "\n[uitvoer afgekapt]";
  if (open) uitvoer += "\n[uitvoer afgebroken: een pipe bleef open na de exit]";
  return { exit: p.signalCode ? null : exit, uitvoer, ...(p.signalCode ? { reden: `gestopt met ${p.signalCode} (timeout ${o.timeoutMs} ms?)` } : {}) };
};

/** Een akkoord dat niet bewezen van Brian is: geen eindstand, het verzoek blijft open. */
export interface Onbewezen { id: string; stand: "onbewezen"; reden: string }
export type Afloop = Uitslag | Onbewezen;

export interface Opties {
  map: string;
  ctx: Ctx;
  sleutels: Sleutels;
  nu?: () => number;
  spawn?: Spawner;
  /**
   * Alleen in test-stand: argv[0] komt uit deze map, nooit van PATH. Zonder nepBin draait test-stand
   * alleen argv[0] uit TEST_ZONDER_NEP (/bin/echo van proef-echo), zodat een test nooit de echte tailscale
   * of bash raakt. alleenTest alleen is niet genoeg: tak-weg is ook alleenTest.
   */
  nepBin?: string;
  /** Alleen voor tests: overschrijft de timeout van de soort. */
  timeoutMs?: number;
  /** Alleen voor tests: hoe lang de runner na de exit nog op de pipes wacht. */
  naExitMs?: number;
  /** Logregels (standaard stderr, dus de log van de LaunchAgent). */
  log?: (regel: string) => void;
}

const pad = (o: Opties, map: keyof typeof MAPPEN, naam: string) => path.join(o.map, MAPPEN[map], naam);

/** Elke submap moet een echte map zijn (geen symlink), van deze gebruiker en niet schrijfbaar voor anderen. */
export function controleerMappen(map: string): void {
  const uid = process.getuid?.();
  for (const p of [map, ...Object.values(MAPPEN).map((m) => path.join(map, m))]) {
    const s = lstatSync(p);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new Error(`${p} is geen gewone map`);
    if (uid !== undefined && s.uid !== uid) throw new Error(`${p}: eigenaar uid ${s.uid}, verwacht ${uid}`);
    if (s.mode & 0o077) throw new Error(`${p}: modus ${(s.mode & 0o777).toString(8)}, verwacht 700`);
  }
}

function schrijfUitslag(o: Opties, u: Uitslag): void {
  schrijfAtomair(pad(o, "uitslag", `${u.id}.json`), `${JSON.stringify(u, null, 2)}\n`);
}

function meldLead(lead: string | undefined, u: Uitslag, soortId: string | undefined, nu: number): void {
  if (!lead) return;
  const delen = [`commando ${soortId ?? "?"} ${u.id}: ${u.stand}${u.exit === undefined ? "" : ` exit ${u.exit}`}`];
  if (u.reden) delen.push(u.reden.slice(0, 120));
  for (const r of u.staart.slice(-2)) delen.push(r.slice(0, 100));
  delen.push(`zie bun scripts/lead/vraag-brian.ts lees ${u.id}`);
  inboxRegel(lead, VAN, delen.join(" | "), nu);
}

/** argv[0] in test-stand: alleen uit nepBin, als gewoon uitvoerbaar bestand. */
function nepPad(nepBin: string, naam: string): string {
  const p = path.join(nepBin, path.basename(naam));
  const s = lstatSync(p, { throwIfNoEntry: false });
  if (!s || !s.isFile()) throw new Error(`nep-binary ${path.basename(naam)} ontbreekt in ${nepBin}`);
  return p;
}

/**
 * Wat live mag draaien (fase 1): alleen tailscale met een vast absoluut pad en cwd /. Geen soort draait
 * live uit de clone of een andere map die de gebruiker (en dus een agent) kan wijzigen; tak-weg wacht
 * op fase 1b (GitHub-API, zonder repo-code).
 */
export const LIVE_ARGV0: readonly string[] = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
export const LIVE_CWD = "/";
/** Wat test-stand zonder --nep-bin echt mag draaien: alleen onschuldige binaries met een vast pad. */
export const TEST_ZONDER_NEP: readonly string[] = ["/bin/echo"];

/** Hoe vaak deze soort in de laatste 24 uur is gestart, volgens het grootboek (`<tijd> <soort>` per id). */
export function startsVandaag(map: string, soortId: string, nu: number): number {
  const grens = nu - 86_400_000;
  let n = 0;
  for (const naam of readdirSync(path.join(map, MAPPEN.gebruikt))) {
    if (!ID.test(naam)) continue; // `<id>.afgewezen` telt niet
    let regel: string;
    try {
      regel = leesGewoonBestand(path.join(map, MAPPEN.gebruikt, naam)).trim();
    } catch {
      continue;
    }
    const [t, s] = regel.split(" ");
    if (s === soortId && Date.parse(t ?? "") > grens) n++;
  }
  return n;
}

/**
 * Staat deze https-poort al in `tailscale serve status --json`? tailnet-open mag een bestaande regel
 * nooit overschrijven. Faalt dicht: een status die niet te lezen is, geeft een reden.
 */
export async function tailnetBezet(tailscale: string, https: string, env: Record<string, string>, spawn: Spawner): Promise<string | null> {
  let r: Uitvoering;
  try {
    r = await spawn([tailscale, "serve", "status", "--json"], { cwd: LIVE_CWD, env, timeoutMs: 15_000 });
  } catch (e) {
    return `tailscale serve status start niet: ${(e as Error).message.slice(0, 200)}`;
  }
  if (r.exit !== 0) return `tailscale serve status faalde (exit ${r.exit})`;
  let status: unknown;
  try {
    status = JSON.parse(r.uitvoer.trim() || "{}");
  } catch {
    return "tailscale serve status is geen JSON";
  }
  if (!status || typeof status !== "object") return "tailscale serve status is geen object";
  const s = status as { TCP?: Record<string, unknown>; Web?: Record<string, unknown> };
  if (s.TCP && Object.hasOwn(s.TCP, https)) return `https-poort ${https} staat al in tailscale serve`;
  if (s.Web && Object.keys(s.Web).some((k) => k.endsWith(`:${https}`))) return `https-poort ${https} staat al in tailscale serve`;
  return null;
}

/**
 * Verwerkt één akkoord. Geeft de uitslag, `onbewezen`, of null als er niets te doen was (al geclaimd, replay).
 *
 * Twee soorten weigering:
 * - onbewezen (ongeldig akkoord of verzoek, id of hash klopt niet, handtekening klopt niet): dat kan
 *   iedereen neerleggen. Geen eindstand, het verzoek blijft open en het akkoord gaat weg; een logregel
 *   op stderr en hooguit één inbox-regel per verzoek (marker `gebruikt/<id>.afgewezen`).
 * - bewezen (Brian tekende, maar verlopen, te lang geldig, stiltevenster, maxPerDag, niet live toegestaan):
 *   eindstand `fout` of `verlopen` met de reden. Er draait niets.
 */
export async function verwerk(id: string, o: Opties): Promise<Afloop | null> {
  const nu = o.nu ?? Date.now;
  const spawn = o.spawn ?? echteSpawner;
  const log = o.log ?? ((r: string) => console.error(r));
  const tijd = () => new Date(nu()).toISOString();
  if (!ID.test(id)) return null;

  // 1. Claimen: maar één run wint.
  const claim = pad(o, "akkoord", `${id}.json.claim.${process.pid}`);
  try {
    renameSync(pad(o, "akkoord", `${id}.json`), claim);
  } catch {
    return null;
  }
  let verzoek: Verzoek | undefined;
  let soort: Soort | undefined;
  const onbewezen = (reden: string): Onbewezen => {
    log(`commando-runner: ${id} onbewezen, niets uitgevoerd: ${reden}`);
    try {
      closeSync(openSync(pad(o, "gebruikt", `${id}.afgewezen`), "wx", 0o600));
      if (verzoek) inboxRegel(verzoek.lead, VAN, `commando ${soort?.id ?? verzoek.soort} ${id}: akkoord niet bewezen, niets uitgevoerd | ${reden.slice(0, 120)} | het verzoek staat nog open`, nu());
    } catch {
      // al gemeld voor dit verzoek
    }
    return { id, stand: "onbewezen", reden };
  };
  const weiger = (reden: string, stand: "fout" | "verlopen" = "fout"): Uitslag => {
    const u: Uitslag = { versie: 1, id, stand, staart: [], reden, tijd: tijd() };
    schrijfUitslag(o, u);
    meldLead(verzoek?.lead, u, soort?.id, nu());
    return u;
  };
  try {
    // 2. Replay: een id draait hooguit één keer, en een bestaande uitslag blijft staan.
    if (existsSync(pad(o, "gebruikt", id)) || existsSync(pad(o, "uitslag", `${id}.json`))) return null;

    // 3. Verzoek en akkoord strikt lezen; argv, cwd, env en de hash zelf afleiden. Tot en met de
    //    handtekening is niets bewezen van Brian.
    let akkoord: Akkoord;
    try {
      verzoek = valideerVerzoek(JSON.parse(leesGewoonBestand(pad(o, "verzoeken", `${id}.json`))));
    } catch (e) {
      return onbewezen(`verzoek ongeldig: ${(e as Error).message.slice(0, 200)}`);
    }
    try {
      akkoord = valideerAkkoord(JSON.parse(leesGewoonBestand(claim)));
    } catch (e) {
      return onbewezen(`akkoord ongeldig: ${(e as Error).message.slice(0, 200)}`);
    }
    if (akkoord.id !== id || verzoek.id !== id) return onbewezen("id in het bestand hoort niet bij de bestandsnaam");
    soort = zoekSoort(verzoek.soort, o.ctx);
    if (!soort) return onbewezen(`onbekende soort ${verzoek.soort}`);
    const namen = Object.keys(soort.params).sort();
    const gegeven = Object.keys(verzoek.params).sort();
    if (namen.join(",") !== gegeven.join(",")) return onbewezen(`params ${gegeven.join(",")} passen niet bij ${soort.id} (${namen.join(",")})`);
    for (const n of namen) if (!soort.params[n]!.test(verzoek.params[n]!)) return onbewezen(`param ${n} ongeldig voor ${soort.id}`);
    const extra = soort.extraCheck?.(verzoek.params) ?? null;
    if (extra) return onbewezen(extra);
    const { argv, cwd, env } = afgeleid(verzoek, o.ctx);
    const hash = verzoekHash(verzoek, o.ctx);
    if (akkoord.hash !== hash) return onbewezen("het verzoek of de sjabloon is gewijzigd na het akkoord");

    // 4. De handtekening van Brian over precies deze hash, nonce en vervaltijd.
    const fout = await controleerHandtekening(akkoord, challenge(id, hash, akkoord.nonce, akkoord.verlooptS), o.sleutels);
    if (fout) return onbewezen(fout);

    // 5. Geldigheid, stiltevenster en maxPerDag.
    const nuS = Math.floor(nu() / 1000);
    if (akkoord.verlooptS <= nuS) return weiger("akkoord verlopen", "verlopen");
    if (akkoord.verlooptS > nuS + MAX_AKKOORD_S + KLOK_MARGE_S) return weiger("akkoord geldt te lang");
    if (verzoek.verlooptS <= nuS) return weiger("verzoek verlopen", "verlopen");
    const stil = stilteReden(soort, o.ctx, new Date(nu()));
    if (stil) return weiger(stil);
    if (startsVandaag(o.map, soort.id, nu()) >= soort.maxPerDag) return weiger(`${soort.id} draaide al ${soort.maxPerDag} keer in 24 uur (maxPerDag)`);

    // 6. Live alleen tailscale met een vast pad; test-stand raakt nooit een echte binary, behalve een testsoort.
    let uitArgv = argv;
    if (!o.ctx.test) {
      if (!LIVE_ARGV0.includes(argv[0]!) || cwd !== LIVE_CWD) return weiger(`${soort.id} draait in fase 1 niet live (alleen tailscale met een vast pad en cwd /)`);
    } else if (o.nepBin) {
      try {
        uitArgv = [nepPad(o.nepBin, argv[0]!), ...argv.slice(1)];
      } catch (e) {
        return weiger((e as Error).message);
      }
    } else if (!TEST_ZONDER_NEP.includes(argv[0]!)) return weiger(`test-stand zonder --nep-bin draait alleen ${TEST_ZONDER_NEP.join(", ")}, niet ${soort.id}`);

    // 7. Grootboek vóór de uitvoering (exclusief aanmaken: wie tweede is, stopt).
    try {
      const fd = openSync(pad(o, "gebruikt", id), "wx", 0o600);
      writeSync(fd, `${tijd()} ${soort.id}\n`);
      closeSync(fd);
    } catch {
      return null;
    }
    schrijfUitslag(o, { versie: 1, id, stand: "bezig", staart: [], tijd: tijd() });

    // Vanaf hier staat `bezig`: elke fout wordt een eindstand, nooit een hangende `bezig`.
    try {
      // 8. Uitvoeren. Een binary die niet start, wordt `fout`, geen hangende `bezig`.
      let r: Uitvoering;
      const voorFout = soort.id === "tailnet-open" ? await tailnetBezet(uitArgv[0]!, verzoek.params.https!, env, spawn) : null;
      if (voorFout) r = { exit: null, uitvoer: "", reden: voorFout };
      else {
        try {
          r = await spawn(uitArgv, { cwd, env, timeoutMs: o.timeoutMs ?? soort.timeoutMs, ...(o.naExitMs === undefined ? {} : { naExitMs: o.naExitMs }) });
        } catch (e) {
          r = { exit: null, uitvoer: "", reden: `starten mislukt: ${(e as Error).message.slice(0, 200)}` };
        }
      }

      // 9. Redigeren, log, uitslag, inbox.
      const schoon = redigeer(r.uitvoer);
      const toon = soort.uitvoer === "toon";
      if (toon) schrijfAtomair(pad(o, "uitvoer", `${id}.log`), schoon);
      const u: Uitslag = {
        versie: 1,
        id,
        stand: r.exit === 0 ? "klaar" : "fout",
        ...(r.exit === null ? {} : { exit: r.exit }),
        staart: toon ? staart(schoon) : [],
        ...(r.reden ? { reden: redigeer(r.reden) } : {}),
        tijd: tijd(),
      };
      schrijfUitslag(o, u);
      try {
        meldLead(verzoek.lead, u, soort.id, nu());
      } catch (e) {
        log(`commando-runner: ${id}: inbox: ${(e as Error).message.slice(0, 200)}`); // de uitslag staat al
      }
      return u;
    } catch (e) {
      return weiger(`runner-fout: ${(e as Error).message.slice(0, 200)}`);
    }
  } finally {
    rmSync(claim, { force: true });
  }
}

/** Ruimt uitvoer/*.log ouder dan 7 dagen op. */
export function ruimUitvoerOp(o: Opties): void {
  const grens = (o.nu ?? Date.now)() - UITVOER_DAGEN * 86_400_000;
  const map = path.join(o.map, MAPPEN.uitvoer);
  for (const naam of readdirSync(map)) {
    const p = path.join(map, naam);
    const s = lstatSync(p);
    if (s.isFile() && s.mtimeMs < grens) rmSync(p, { force: true });
  }
}

/** Verwerkt alle akkoorden die nu klaarliggen (oudste eerst, hooguit MAX_PER_RUN). Een fout stopt de rest niet. */
export async function verwerkAlles(o: Opties): Promise<Afloop[]> {
  controleerMappen(o.map);
  const log = o.log ?? ((r: string) => console.error(r));
  const map = path.join(o.map, MAPPEN.akkoord);
  const ids = readdirSync(map)
    .filter((n) => n.endsWith(".json") && ID.test(n.slice(0, -5)))
    .map((n) => ({ id: n.slice(0, -5), t: statSync(path.join(map, n), { throwIfNoEntry: false })?.mtimeMs ?? 0 }))
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_PER_RUN);
  const uit: Afloop[] = [];
  for (const { id } of ids) {
    try {
      const u = await verwerk(id, o);
      if (u) uit.push(u);
    } catch (e) {
      log(`commando-runner: ${id}: ${(e as Error).message.slice(0, 200)}`);
    }
  }
  ruimUitvoerOp(o);
  return uit;
}


if (import.meta.main) {
  const args = process.argv.slice(2);
  const stop = (m: string): never => {
    console.error(`commando-runner: ${m}`);
    process.exit(1);
  };
  const waarde = (naam: string) => {
    const i = args.indexOf(naam);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (!v || v.startsWith("--")) stop(`${naam} mist een waarde`);
    return v;
  };
  const bekend = ["--live", "--map", "--sleutels", "--nep-bin", "--eenmaal"];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!bekend.includes(a)) stop(`onbekende optie ${a}`);
    if (["--map", "--sleutels", "--nep-bin"].includes(a)) i++;
  }
  const live = args.includes("--live");
  let opties: Opties;
  try {
    if (live) {
      if (args.some((a) => ["--map", "--sleutels", "--nep-bin"].includes(a))) stop("--live neemt geen --map, --sleutels of --nep-bin");
      zorgVoorMappen(commandoMap());
      opties = { map: commandoMap(), ctx: runnerCtx(true), sleutels: leesSleutels(SLEUTELS_PAD, 0) };
    } else {
      const map = waarde("--map");
      const sleutels = waarde("--sleutels");
      if (!testStand(process.env)) stop("zonder --live alleen in test-stand: LAB_COMMANDO_TEST=1 en geen TMUX_PWA_LIVE");
      if (!map || !sleutels) stop("zonder --live zijn --map en --sleutels verplicht (test-stand)");
      const echt = path.resolve(path.join(homedir(), ".local/state/lab-commando"));
      if (path.resolve(map!) === echt) stop(`test-stand op de echte map ${echt} weigert`);
      zorgVoorMappen(path.resolve(map!));
      const nepBin = waarde("--nep-bin");
      opties = {
        map: path.resolve(map!),
        ctx: runnerCtx(false),
        sleutels: leesSleutels(path.resolve(sleutels!), null),
        ...(nepBin ? { nepBin: path.resolve(nepBin) } : {}),
      };
    }
  } catch (e) {
    stop((e as Error).message);
  }
  try {
    for (const u of await verwerkAlles(opties!)) console.log(`${u.id} ${u.stand}${"exit" in u && u.exit !== undefined ? ` exit ${u.exit}` : ""}${u.reden ? ` (${u.reden})` : ""}`);
  } catch (e) {
    stop((e as Error).message);
  }
}
