#!/usr/bin/env bun
// Merge-wachtrij voor de lead. Gebruik: bun scripts/lead/wachtrij.ts [--droog] [opties]
// Verzamelt open PR's met "Lead-review: akkoord <sha7>" (gelijk aan de head), bouwt
// wachtrij/<jjjjmmdd-hhmm> vanaf origin/main, draait één volledige poort en opent één
// integratie-PR. Zie scripts/lead/README.md.
import { existsSync } from "node:fs";
import path from "node:path";
import { schoneEnv } from "../test-integriteit.ts";

export type Pr = {
  number: number;
  title: string;
  body: string;
  headRefName: string;
  headRefOid: string;
  baseRefName?: string;
  isCrossRepository: boolean;
  isDraft?: boolean;
  comments: { body: string }[];
};

export type Afgevallen = { nummer: number; reden: string };

/** Open PR's met een akkoord op de huidige head; in volgorde van PR-nummer. */
export function kiesPrs(prs: Pr[]): { gekozen: Pr[]; afgevallen: Afgevallen[] } {
  const gekozen: Pr[] = [];
  const afgevallen: Afgevallen[] = [];
  for (const pr of [...prs].sort((a, b) => a.number - b.number)) {
    const sha = pr.headRefOid.slice(0, 7);
    if (pr.baseRefName !== "main") afgevallen.push({ nummer: pr.number, reden: `base is ${pr.baseRefName ?? "onbekend"}, niet main (gestapelde PR)` });
    else if (pr.isCrossRepository) afgevallen.push({ nummer: pr.number, reden: "komt uit een fork" });
    else if (pr.isDraft) afgevallen.push({ nummer: pr.number, reden: "is een concept" });
    else if (["main", "master"].includes(pr.headRefName)) afgevallen.push({ nummer: pr.number, reden: `tak is ${pr.headRefName}` });
    else if (pr.headRefName.startsWith("wachtrij/")) afgevallen.push({ nummer: pr.number, reden: "is zelf een integratie-PR" });
    else if (pr.comments.some((c) => new RegExp(`^Lead-review: akkoord ${sha}([^0-9a-fA-F]|$)`).test(c.body))) gekozen.push(pr);
    else if (pr.comments.some((c) => c.body.startsWith("Lead-review: akkoord"))) afgevallen.push({ nummer: pr.number, reden: `verouderd akkoord: geen "Lead-review: akkoord ${sha}"` });
  }
  return { gekozen, afgevallen };
}

/** Alle `OK bekijk <app>: …`-regels uit de bodies, ontdubbeld, met het PR-nummer erbij. */
export function okRegels(prs: Pr[]): string[] {
  const uit: string[] = [];
  for (const pr of prs) {
    for (const r of pr.body.split("\n")) {
      const m = r.match(/OK\s+bekijk\s+[^\n`]+/);
      if (m && !/\bFOUT\b/.test(m[0]) && !uit.some((x) => x.startsWith(m[0].trim()))) uit.push(`${m[0].trim()} (uit #${pr.number})`);
    }
  }
  return uit;
}

function mergeGevaar(body: string): string {
  const m = body.match(/^##\s+Merge-gevaar\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
  return (m?.[1] ?? "").trim();
}

/** Zwaarte van een Merge-gevaar-tekst: eenrichting weegt zwaarder dan data/live, dat weer zwaarder dan niets. */
export function gevaarScore(tekst: string): number {
  const t = tekst.toLowerCase().replace(/eenrichting of tweerichting/g, "");
  let s = 0;
  if (/\beenrichting\b/.test(t) && !/\btweerichting\b/.test(t)) s += 4;
  if (/\b(live|uitrol|productie|data|instellingen|migratie)\b/.test(t) && !/\b(geen|niet)\s+(data|live|instellingen)/.test(t)) s += 1;
  return s;
}

/** De Merge-gevaar-sectie van de zwaarste onderliggende PR (bij gelijk: de laagste PR). */
export function zwaarsteGevaar(prs: Pr[]): { nummer: number; tekst: string } | null {
  let beste: { nummer: number; tekst: string; score: number } | null = null;
  for (const pr of prs) {
    const tekst = mergeGevaar(pr.body);
    if (!tekst) continue;
    const score = gevaarScore(tekst);
    if (!beste || score > beste.score) beste = { nummer: pr.number, tekst, score };
  }
  return beste ? { nummer: beste.nummer, tekst: beste.tekst } : null;
}

export const MARKER = "Wachtrij-PR's:";

/** Eén regel die --ruim-takken terugleest: "Wachtrij-PR's: 12=tak=sha40 15=tak=sha40". */
export const markerRegel = (prs: Pr[]) => `${MARKER} ${prs.map((p) => `${p.number}=${p.headRefName}=${p.headRefOid}`).join(" ")}`;

export function leesMarker(body: string): { nummer: number; tak: string; sha: string }[] {
  // de laatste marker-regel telt: de echte staat onderaan, na ingevoegde tekst van onderliggende PR's
  const r = body.split("\n").filter((x) => x.startsWith(MARKER)).pop();
  if (!r) return [];
  return r
    .slice(MARKER.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((d) => {
      const [n, tak, sha] = d.split("=");
      return { nummer: Number(n), tak, sha };
    })
    .filter((d) => /^\d+$/.test(String(d.nummer)) && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(d.tak ?? "") && /^[0-9a-f]{40}$/.test(d.sha ?? ""));
}

/** Tekst van een onderliggende PR zonder regels die op onze marker lijken. */
const zonderMarker = (t: string) => t.split("\n").filter((r) => !r.trim().startsWith(MARKER)).join("\n");

export function bouwBody(opts: { gemerged: Pr[]; afgevallen: Afgevallen[]; head: string; poortCmd: string }): string {
  const { gemerged, afgevallen, head } = opts;
  const lijst = gemerged.map((p) => `- #${p.number} ${p.title} (${p.headRefName}, ${p.headRefOid.slice(0, 7)})`).join("\n");
  const ok = okRegels(gemerged);
  const gevaar = zwaarsteGevaar(gemerged);
  const eruit = afgevallen.length ? `\n\nNiet meegenomen:\n${afgevallen.map((a) => `- #${a.nummer}: ${a.reden}`).join("\n")}` : "";
  return [
    "## Samenvatting",
    "",
    `Integratie-PR van de merge-wachtrij: ${gemerged.length} onderliggende PR's, in volgorde samengevoegd vanaf origin/main. Na het mergen van deze ene PR sluit GitHub de onderliggende PR's als gemerged; hun remote takken blijven staan tot \`wachtrij.ts --ruim-takken\`.`,
    "",
    lijst + eruit,
    "",
    "## Bewijs",
    "",
    // "met e2e" alleen bij de standaardpoort; een eigen commando bewijst dat niet (bewijs-pr leest alleen de regel)
    opts.poortCmd === STANDAARD_POORT
      ? `- poort: groen (met e2e) op ${head.slice(0, 7)} (\`${opts.poortCmd}\`): ${gemerged.map((p) => `#${p.number}`).join(", ")}`
      : `- poort: eigen commando \`${opts.poortCmd}\` op ${head.slice(0, 7)}, geen e2e-bewijs: ${gemerged.map((p) => `#${p.number}`).join(", ")}`,
    ...(ok.length ? ok.map((r) => `- ${r}`) : ["- Geen app-wijziging met bekijk-regel in de onderliggende PR's."]),
    "",
    "## Merge-gevaar",
    "",
    gevaar
      ? `Zwaarste van de onderliggende PR's: #${gevaar.nummer}.\n\n${zonderMarker(gevaar.tekst)}`
      : "Geen Merge-gevaar-sectie gevonden in de onderliggende PR's; lees ze zelf na.",
    "",
    markerRegel(gemerged),
    "",
    "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    "",
  ].join("\n");
}

// ── Stiltevenster (zelfde venster als scripts/poort.ts) ──────────────────────

export function inStiltevenster(nu: Date): boolean {
  const m = nu.getHours() * 60 + nu.getMinutes();
  return m >= 5 * 60 && m < 7 * 60 + 15;
}

/** "20261006-1430" → Date (lokale tijd). */
export function leesStempel(s: string): Date | null {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

export function stempelVan(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ── Uitvoering ───────────────────────────────────────────────────────────────

type Opties = {
  droog: boolean;
  poortCmd: string;
  nu: string | null;
  basis: string;
  map: string | null;
  ruim: boolean;
  pr: string | null;
};

export const STANDAARD_POORT = "bun install --frozen-lockfile && bun run poort";

export function leesOpties(args: string[]): Opties | string {
  const o: Opties = { droog: false, poortCmd: STANDAARD_POORT, nu: null, basis: "origin/main", map: null, ruim: false, pr: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const waarde = () => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} mist een waarde`);
      return v;
    };
    try {
      if (a === "--droog") o.droog = true;
      else if (a === "--poort-cmd") o.poortCmd = waarde();
      else if (a === "--nu") o.nu = waarde();
      else if (a === "--basis") o.basis = waarde();
      else if (a === "--map") o.map = waarde();
      else if (a === "--ruim-takken") o.ruim = true;
      else if (/^\d+$/.test(a)) o.pr = a;
      else return `onbekende optie: ${a}`;
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (o.nu && !leesStempel(o.nu)) return `--nu moet jjjjmmdd-hhmm zijn, kreeg ${o.nu}`;
  if (o.pr && !o.ruim) return "een PR-nummer hoort bij --ruim-takken";
  return o;
}

const run = (cmd: string[], cwd?: string) => {
  const r = Bun.spawnSync(cmd, { cwd, env: schoneEnv(), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, uit: r.stdout.toString().trim(), fout: r.stderr.toString().trim() };
};

const klaar = (code: number, tekst: string): never => {
  (code === 0 ? console.log : console.error)(tekst);
  process.exit(code);
};

function ghJson<T>(args: string[]): T {
  const r = run(["gh", ...args]);
  if (r.code !== 0) return klaar(1, `wachtrij: gh ${args.slice(0, 2).join(" ")} mislukt: ${r.fout}`);
  return JSON.parse(r.uit) as T;
}

function ruimTakken(o: Opties, root: string): never {
  let pr = o.pr;
  if (!pr) {
    const lijst = ghJson<{ number: number; headRefName: string }[]>(["pr", "list", "--state", "merged", "--limit", "30", "--json", "number,headRefName"]);
    const laatste = lijst.filter((p) => p.headRefName.startsWith("wachtrij/")).sort((a, b) => b.number - a.number)[0];
    if (!laatste) return klaar(1, "wachtrij: geen gemergede integratie-PR gevonden; geef het nummer mee");
    pr = String(laatste.number);
  }
  const info = ghJson<{ state: string; body: string; headRefName: string }>(["pr", "view", pr, "--json", "state,body,headRefName"]);
  if (info.state !== "MERGED") return klaar(1, `wachtrij: PR ${pr} staat op ${info.state}, niet MERGED; niets verwijderd`);
  if (!info.headRefName.startsWith("wachtrij/")) return klaar(1, `wachtrij: PR ${pr} is geen integratie-PR (tak ${info.headRefName})`);
  const onderliggend = leesMarker(info.body);
  if (!onderliggend.length) return klaar(1, `wachtrij: PR ${pr} bevat geen geldige "${MARKER}"-regel`);
  const f = run(["git", "fetch", "origin", "main"], root);
  if (f.code !== 0) return klaar(1, `wachtrij: git fetch mislukt: ${f.fout}`);
  let fouten = 0;
  for (const d of onderliggend) {
    const anc = run(["git", "merge-base", "--is-ancestor", d.sha, "origin/main"], root);
    if (anc.code !== 0) {
      console.error(`wachtrij: #${d.nummer} (${d.tak}): head ${d.sha.slice(0, 7)} staat niet in origin/main, tak blijft staan`);
      fouten++;
      continue;
    }
    // de body is niet te vertrouwen: de PR zelf moet MERGED zijn met precies deze tak en head
    const onder = run(["gh", "pr", "view", String(d.nummer), "--json", "state,headRefName,headRefOid"]);
    const o2 = onder.code === 0 ? (JSON.parse(onder.uit) as { state: string; headRefName: string; headRefOid: string }) : null;
    if (!o2 || o2.state !== "MERGED" || o2.headRefName !== d.tak || o2.headRefOid !== d.sha) {
      console.error(`wachtrij: #${d.nummer} (${d.tak}): PR is niet MERGED met deze tak en head volgens GitHub, tak blijft staan`);
      fouten++;
      continue;
    }
    const ref = `refs/heads/${d.tak}`;
    const staat = run(["git", "ls-remote", "origin", ref], root).uit;
    const [staatSha, staatRef] = staat.split(/\s+/);
    if (!staat) {
      console.log(`wachtrij: #${d.nummer}: remote tak ${d.tak} bestond al niet meer`);
      continue;
    }
    if (staatRef !== ref || staatSha !== d.sha) {
      console.error(`wachtrij: #${d.nummer} (${d.tak}): remote tak staat op een andere sha dan gemerged, blijft staan`);
      fouten++;
      continue;
    }
    if (o.droog) {
      console.log(`droog: zou remote tak ${d.tak} (#${d.nummer}) verwijderen`);
      continue;
    }
    // met lease: een commit die tussen controle en verwijderen is gepusht, blokkeert het verwijderen
    const del = run(["git", "push", `--force-with-lease=${ref}:${d.sha}`, "origin", `:${ref}`], root);
    if (del.code !== 0) {
      console.error(`wachtrij: verwijderen van ${d.tak} mislukt: ${del.fout}`);
      fouten++;
    } else console.log(`wachtrij: remote tak ${d.tak} (#${d.nummer}) verwijderd`);
  }
  return klaar(fouten ? 1 : 0, fouten ? `wachtrij: ${fouten} tak(ken) niet verwijderd` : "wachtrij: klaar");
}

function hoofd(args: string[]): never {
  const o = leesOpties(args);
  if (typeof o === "string") return klaar(1, `wachtrij: ${o}`);
  const root = run(["git", "rev-parse", "--show-toplevel"]).uit;
  if (!root) return klaar(1, "wachtrij: draai dit in een git-clone van de repo");
  if (o.ruim) return ruimTakken(o, root);

  const lijst = ghJson<Pr[]>([
    "pr", "list", "--state", "open", "--limit", "100",
    "--json", "number,title,body,headRefName,headRefOid,baseRefName,isCrossRepository,isDraft,comments",
  ]);
  const { gekozen, afgevallen } = kiesPrs(lijst);
  for (const a of afgevallen) console.log(`wachtrij: #${a.nummer} overgeslagen: ${a.reden}`);
  if (!gekozen.length) return klaar(0, "wachtrij: leeg, geen open PR met een geldig \"Lead-review: akkoord <sha7>\"");

  // --nu bepaalt alleen de naam van de tak; het stiltevenster gaat op de echte klok
  // (alleen de test overschrijft die, met env LAB_WACHTRIJ_KLOK).
  const nu = process.env.LAB_WACHTRIJ_KLOK ? (leesStempel(process.env.LAB_WACHTRIJ_KLOK) ?? new Date()) : new Date();
  const stempel = o.nu ?? stempelVan(nu);
  const tak = `wachtrij/${stempel}`;
  const map = o.map ?? path.join(path.dirname(root), `${path.basename(root)}-wachtrij-${stempel}`);

  if (o.droog) {
    console.log(`droog: wachtrij van ${gekozen.length} PR('s):`);
    for (const p of gekozen) console.log(`  #${p.number} ${p.headRefName} ${p.headRefOid.slice(0, 7)} ${p.title}`);
    console.log(`droog: zou tak ${tak} maken in ${map} vanaf ${o.basis}, ze in deze volgorde samenvoegen (--no-ff),`);
    console.log(`droog: dan \`${o.poortCmd}\` draaien, de tak pushen en één integratie-PR openen.`);
    if (inStiltevenster(nu)) console.log("droog: let op, nu is het stiltevenster 05:00–07:15; een echte run weigert.");
    return klaar(0, "droog: niets gedaan");
  }

  if (inStiltevenster(nu)) return klaar(1, "wachtrij: stiltevenster 05:00–07:15, geen zware poort; draai na 07:15 opnieuw");
  if (existsSync(map)) return klaar(1, `wachtrij: ${map} bestaat al; kies een andere --map of ruim hem eerst op`);
  const f = run(["git", "fetch", "origin"], root);
  if (f.code !== 0) return klaar(1, `wachtrij: git fetch mislukt: ${f.fout}`);
  const w = run(["git", "worktree", "add", "-b", tak, map, o.basis], root);
  if (w.code !== 0) return klaar(1, `wachtrij: worktree maken mislukt: ${w.fout}`);

  const gemerged: Pr[] = [];
  const eruit: Afgevallen[] = [...afgevallen];
  for (const p of gekozen) {
    const h = run(["git", "fetch", "origin", p.headRefName], map);
    const sha = h.code === 0 ? run(["git", "rev-parse", "FETCH_HEAD"], map).uit : "";
    if (sha !== p.headRefOid) {
      eruit.push({ nummer: p.number, reden: h.code === 0 ? `tak is verschoven na het akkoord (${sha.slice(0, 7)})` : "tak niet op te halen" });
      console.error(`wachtrij: #${p.number} eruit: ${eruit[eruit.length - 1].reden}`);
      continue;
    }
    const m = run(["git", "merge", "--no-ff", "-m", `Merge PR #${p.number} (${p.headRefName}) in ${tak}`, p.headRefOid], map);
    if (m.code !== 0) {
      run(["git", "merge", "--abort"], map);
      eruit.push({ nummer: p.number, reden: "mergeconflict met de wachtrij" });
      console.error(`wachtrij: #${p.number} eruit: mergeconflict`);
      continue;
    }
    gemerged.push(p);
    console.log(`wachtrij: #${p.number} samengevoegd`);
  }
  if (!gemerged.length) {
    run(["git", "worktree", "remove", map], root);
    run(["git", "branch", "-d", tak], root);
    return klaar(1, "wachtrij: geen enkele PR bleef over; worktree en tak opgeruimd");
  }

  console.log(`wachtrij: poort draaien in ${map}: ${o.poortCmd}`);
  const poort = Bun.spawnSync(["sh", "-c", o.poortCmd], { cwd: map, env: schoneEnv(), stdout: "inherit", stderr: "inherit" });
  if (poort.exitCode !== 0) {
    return klaar(1, `wachtrij: poort rood (exit ${poort.exitCode}); geen push, geen PR. Worktree ${map} en tak ${tak} blijven staan om te kijken`);
  }
  const vies = run(["git", "status", "--porcelain"], map).uit;
  if (vies) return klaar(1, `wachtrij: de poort liet gewijzigde bestanden achter (de gepushte commit is dan niet wat de poort zag); geen push, geen PR:\n${vies}`);
  const head = run(["git", "rev-parse", "HEAD"], map).uit;
  const push = run(["git", "push", "-u", "origin", tak], map);
  if (push.code !== 0) return klaar(1, `wachtrij: push mislukt: ${push.fout}`);
  const body = bouwBody({ gemerged, afgevallen: eruit, head, poortCmd: o.poortCmd });
  const titel = `wachtrij: ${gemerged.map((p) => `#${p.number}`).join(" ")}`;
  const pr = run(["gh", "pr", "create", "--base", "main", "--head", tak, "--title", titel, "--body", body], map);
  if (pr.code !== 0) return klaar(1, `wachtrij: PR openen mislukt: ${pr.fout}`);
  return klaar(0, `wachtrij: integratie-PR geopend: ${pr.uit}\nGeef daarop "Lead-review: akkoord ${head.slice(0, 7)}" en draai merge.sh. Opruimen na MERGED: worktree ${map}, daarna \`bun scripts/lead/wachtrij.ts --ruim-takken\`.`);
}

if (import.meta.main) hoofd(process.argv.slice(2));
