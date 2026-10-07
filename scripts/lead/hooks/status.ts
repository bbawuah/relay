// lead status: leest het register van de hooks (geen ListAgents, geen tmux).
//
//   bun scripts/lead/hooks/status.ts [--json] [--alles] [--lead <n>] [--git]
//
//   --json       machineleesbaar (lijst records plus afgeleide velden `vastgelopen`, `kinderen`, `git`)
//   --alles      ook sessies met toestand `weg` en afgeronde subagents
//   --lead <n>   alleen sessies van die lead
//   --git        per cwd: schoon/vuil, tak, of HEAD in origin/main zit (laatste fetch, geen netwerk)
//
// Vastgelopen (afgeleid, met `?`): `bezig` zonder tool-event > 20 min, of `goedkeuring` > 10 min.
// Records met toestand `weg` ouder dan 24 u worden hier opgeruimd.

import { existsSync, rmSync } from "node:fs";
import { type Omgeving, type Rec, alleRecords, recordPad, staatMap, tijd } from "./register";

export const BEZIG_MAX_MS = 20 * 60_000;
export const GOEDKEURING_MAX_MS = 10 * 60_000;
export const WEG_BEWAAR_MS = 24 * 3600_000;

export type GitInfo = { bestaat: boolean; schoon: boolean | null; tak: string | null; in_main: boolean | null };
export type Rij = Rec & { vastgelopen: boolean; kinderen: Rij[]; git?: GitInfo };

function activiteit(r: Rec, kinderen: Rec[]): number {
  return Math.max(r.sinds, r.laatste_tool_om ?? 0, ...kinderen.map((k) => Math.max(k.sinds, k.laatste_tool_om ?? 0)));
}

export function vastgelopen(r: Rec, kinderen: Rec[], nu: number): boolean {
  if (r.soort !== "sessie") return false;
  const stil = nu - activiteit(r, kinderen.filter((k) => k.toestand === "bezig"));
  if (r.toestand === "bezig") return stil > BEZIG_MAX_MS;
  if (r.toestand === "goedkeuring") return nu - r.sinds > GOEDKEURING_MAX_MS;
  return false;
}

/** Zonder GIT_*-variabelen, zodat een omringende hook of repo de uitkomst niet beïnvloedt. */
function gitEnv(): Record<string, string> {
  const uit: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) uit[k] = v;
  return uit;
}

function git(cwd: string, args: string[]): { code: number; uit: string } {
  const p = Bun.spawnSync(["git", "-C", cwd, ...args], { env: gitEnv(), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, uit: p.stdout.toString().trim() };
}

export function gitInfo(cwd: string): GitInfo {
  if (!cwd || !existsSync(cwd)) return { bestaat: false, schoon: null, tak: null, in_main: null };
  const s = git(cwd, ["status", "--porcelain"]);
  if (s.code !== 0) return { bestaat: true, schoon: null, tak: null, in_main: null };
  const tak = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const anc = git(cwd, ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  return { bestaat: true, schoon: s.uit === "", tak: tak.code === 0 ? tak.uit : null, in_main: anc.code === 0 ? true : anc.code === 1 ? false : null };
}

export function duur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}u`;
  return `${Math.floor(s / 86400)}d`;
}

export type StatusOpties = { json: boolean; alles: boolean; lead: string | null; git: boolean };

export function leesArgs(argv: string[]): StatusOpties | string {
  const o: StatusOpties = { json: false, alles: false, lead: null, git: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--alles") o.alles = true;
    else if (a === "--git") o.git = true;
    else if (a === "--lead") {
      const w = argv[++i];
      if (!w) return "--lead mist een naam";
      o.lead = w;
    } else return `onbekende optie: ${a}`;
  }
  return o;
}

/** Bouwt de rijen; ruimt oude `weg`-records op (alleen als `ruim`). */
export function bouwRijen(staat: string, nu: number, o: StatusOpties, ruim = true, gitFn: (cwd: string) => GitInfo = gitInfo): Rij[] {
  let recs = alleRecords(staat);
  if (ruim) {
    recs = recs.filter((r) => {
      const oud = (r.toestand === "weg" || (r.soort === "subagent" && r.toestand === "klaar")) && nu - (r.einde ?? r.sinds) > WEG_BEWAAR_MS;
      if (oud) {
        try {
          rmSync(recordPad(staat, r.id), { force: true });
        } catch {
          // negeren
        }
      }
      return !oud;
    });
  }
  const subs = recs.filter((r) => r.soort === "subagent");
  const rijen: Rij[] = recs
    .filter((r) => r.soort === "sessie")
    .filter((r) => (o.alles || r.toestand !== "weg") && (!o.lead || r.lead === o.lead || r.naam === o.lead))
    .map((r) => {
      const eigen = subs.filter((s) => s.ouder === r.id);
      const kinderen = eigen
        .filter((s) => o.alles || s.toestand === "bezig")
        .sort((a, b) => a.start - b.start)
        .map((s) => ({ ...s, vastgelopen: false, kinderen: [] as Rij[] }));
      const rij: Rij = { ...r, vastgelopen: vastgelopen(r, eigen, nu), kinderen };
      if (o.git) rij.git = gitFn(r.cwd);
      return rij;
    });
  return rijen.sort((a, b) => (a.lead + a.naam).localeCompare(b.lead + b.naam) || a.start - b.start);
}

function kort(pad: string): string {
  if (!pad) return "–";
  const d = pad.split("/").filter(Boolean);
  return d.length > 3 ? `…/${d.slice(-2).join("/")}` : pad;
}

function gitTekst(g: GitInfo | undefined): string {
  if (!g) return "";
  if (!g.bestaat) return "worktree weg";
  const delen = [g.schoon === null ? "git?" : g.schoon ? "schoon" : "vuil", g.tak ?? "?", g.in_main === null ? "" : g.in_main ? "in main" : "niet in main"];
  return delen.filter(Boolean).join(" ");
}

export function tabel(rijen: Rij[], nu: number, metGit: boolean): string {
  if (rijen.length === 0) return "geen sessies in het register\n";
  const kop = ["naam", "rol", "lead", "toestand", "sinds", "laatste tool", "rapport", "opdracht"];
  if (metGit) kop.push("git");
  const regels: string[][] = [];
  for (const r of rijen) {
    const toest = r.toestand === "klaar" ? "klaar ✓" : r.toestand === "vrij" ? "vrij ✓" : r.toestand;
    const rapport = r.rapport_om ? tijd(r.rapport_om) : "–";
    regels.push([r.naam || r.id.slice(0, 8), r.rol, r.lead || "–", r.vastgelopen ? `${toest} ?` : toest, duur(nu - r.sinds), r.laatste_tool ?? "–", rapport, kort(r.opdracht), ...(metGit ? [gitTekst(r.git)] : [])]);
    for (const k of r.kinderen) {
      regels.push([`  └ ${k.id.slice(0, 8)}`, `${k.agent_type || "subagent"}`, "", k.toestand, duur(nu - k.sinds), k.laatste_tool ?? "–", "", ""]);
    }
  }
  const breed = kop.map((_, i) => Math.max(kop[i].length, ...regels.map((r) => (r[i] ?? "").length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : (c ?? "").padEnd(breed[i]))).join("  ").trimEnd();
  return `${[kop, ...regels].map(fmt).join("\n")}\n`;
}

export function status(argv: string[], env: Omgeving, nu: number, gitFn?: (cwd: string) => GitInfo): { code: number; stdout: string; stderr: string } {
  const o = leesArgs(argv);
  if (typeof o === "string") return { code: 1, stdout: "", stderr: `${o}\ngebruik: status.ts [--json] [--alles] [--lead <n>] [--git]\n` };
  const rijen = bouwRijen(staatMap(env), nu, o, true, gitFn);
  return { code: 0, stdout: o.json ? `${JSON.stringify(rijen, null, 2)}\n` : tabel(rijen, nu, o.git), stderr: "" };
}

if (import.meta.main) {
  process.umask(0o077);
  const u = status(process.argv.slice(2), process.env, Date.now());
  if (u.stdout) process.stdout.write(u.stdout);
  if (u.stderr) process.stderr.write(u.stderr);
  process.exit(u.code);
}
