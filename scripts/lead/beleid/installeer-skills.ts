import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const MARKER = ".lab-beleid-skill.json";
export const REPO_SKILLS = ["lead", "retro", "grill-me"] as const;
export const LOKALE_SKILLS = ["naar-mod", "tailnet", "vault", "scrawl"] as const;

export type Opties = { doel: string; repo?: string; lokaal?: string; droog?: boolean; controle?: boolean };
export type InstalleerDeps = { voorStageer?: (bron: string) => void };
function geenSymlink(p: string): void { const s = lstatSync(p); if (s.isSymbolicLink()) throw new Error(`${p}: symlinks zijn niet toegestaan`); if (s.isDirectory()) for (const e of readdirSync(p)) geenSymlink(join(p, e)); }
function afwijkingen(bron: string, doel: string, relatief = ""): string[] {
  if (!existsSync(bron)) return [`extra ${relatief || doel}`];
  if (!existsSync(doel)) return [`ontbreekt ${relatief || doel}`];
  const bs = lstatSync(bron); const ds = lstatSync(doel);
  if (ds.isSymbolicLink() || bs.isDirectory() !== ds.isDirectory()) return [`ander type ${relatief || doel}`];
  if (!bs.isDirectory()) return readFileSync(bron).equals(readFileSync(doel)) ? [] : [`gewijzigd ${relatief || doel}`];
  const namen = new Set([...readdirSync(bron), ...readdirSync(doel)]);
  return [...namen].filter((n) => n !== MARKER).flatMap((n) => afwijkingen(join(bron, n), join(doel, n), relatief ? join(relatief, n) : n));
}
function diffTekst(van: string, naar: string, oud: string, nieuw: string): string {
  const oudeRegels = oud.split("\n"); const nieuweRegels = nieuw.split("\n");
  const min = Math.min(oudeRegels.length, nieuweRegels.length);
  const regels = [`--- ${van}`, `+++ ${naar}`, "@@"];
  for (let i = 0; i < min; i++) if (oudeRegels[i] !== nieuweRegels[i]) regels.push(`- ${oudeRegels[i]}`, `+ ${nieuweRegels[i]}`);
  for (let i = min; i < oudeRegels.length; i++) regels.push(`- ${oudeRegels[i]}`);
  for (let i = min; i < nieuweRegels.length; i++) regels.push(`+ ${nieuweRegels[i]}`);
  return regels.join("\n");
}
function diffs(bron: string, doel: string): string[] {
  if (!existsSync(bron)) return [`--- ${doel}\n+++ /dev/null\n- verwijderd`];
  if (!existsSync(doel)) {
    const stat = lstatSync(bron);
    if (stat.isDirectory()) return readdirSync(bron).filter((n) => n !== MARKER).flatMap((n) => diffs(join(bron, n), join(doel, n)));
    return diffTekst("/dev/null", bron, "", readFileSync(bron, "utf8"));
  }
  const bs = lstatSync(bron); const ds = lstatSync(doel);
  if (bs.isDirectory() && ds.isDirectory()) return [...new Set([...readdirSync(bron), ...readdirSync(doel)])]
    .filter((n) => n !== MARKER).flatMap((n) => diffs(join(bron, n), join(doel, n)));
  if (bs.isDirectory() !== ds.isDirectory() || ds.isSymbolicLink()) return [`--- ${doel}\n+++ ${bron}\n@@\n- ander type\n+ ander type`];
  const oud = readFileSync(doel, "utf8"); const nieuw = readFileSync(bron, "utf8");
  return oud === nieuw ? [] : [diffTekst(doel, bron, oud, nieuw)];
}
function plan(bron: string, doel: string, droog: boolean, regels: string[]) {
  regels.push(`${existsSync(doel) ? "vervang" : "installeer"} ${doel}`);
  if (droog) regels.push(...diffs(bron, doel));
}
function stageer(bron: string, doel: string) {
  cpSync(bron, doel, { recursive: true, filter: (p) => !p.endsWith(".system") && !p.includes("/synced/") });
  writeFileSync(join(doel, MARKER), JSON.stringify({ bron: "beleid" }) + "\n", { mode: 0o600 });
}
function vervang(staging: string, doel: string, backupMap: string) {
  if (existsSync(doel)) {
    mkdirSync(backupMap, { recursive: true });
    const stam = `${basename(doel)}.voor-beleid-${Date.now()}`;
    let back = join(backupMap, stam); let volg = 1;
    while (existsSync(back)) back = join(backupMap, `${stam}-${volg++}`);
    renameSync(doel, back);
  }
  renameSync(staging, doel);
}
export function installeer(o: Opties, deps: InstalleerDeps = {}) {
  const repo = o.repo ?? join(import.meta.dir, "../../..", "agents/skills");
  const lokaal = o.lokaal ?? join(process.env.HOME ?? "", "vault-b-status/skills");
  const regels: string[] = [];
  const bronnen = [...REPO_SKILLS.map((n) => [join(repo, n), join(o.doel, n)] as const), ...LOKALE_SKILLS.filter((n) => existsSync(join(lokaal, n))).map((n) => [join(lokaal, n), join(o.doel, n)] as const)];
  // Alles vooraf: een kapotte latere skill mag nooit een eerdere doelmap vervangen.
  for (const [bron, doel] of bronnen) { if (!existsSync(join(bron, "SKILL.md"))) throw new Error(`${bron}: SKILL.md ontbreekt`); geenSymlink(bron); if (!o.controle && existsSync(doel) && (!existsSync(join(doel, MARKER)) || lstatSync(join(doel, MARKER)).isSymbolicLink())) throw new Error(`${doel}: niet door beleid gemarkeerd of marker is symlink`); }
  if (o.controle) {
    for (const [bron, doel] of bronnen) {
      if (!existsSync(doel)) regels.push(`drift ${doel}: ontbreekt`);
      else if (!existsSync(join(doel, MARKER)) || lstatSync(join(doel, MARKER)).isSymbolicLink()) regels.push(`drift ${doel}: marker ontbreekt of is symlink`);
      else for (const afwijking of afwijkingen(bron, doel)) regels.push(`drift ${doel}: ${afwijking}`);
    }
    if (existsSync(o.doel)) {
      const beheerd = new Set(bronnen.map(([, doel]) => basename(doel)));
      for (const naam of readdirSync(o.doel)) {
        if (naam === ".system" || naam === "synced" || beheerd.has(naam)) continue;
        const pad = join(o.doel, naam);
        const isMap = lstatSync(pad).isDirectory();
        const marker = join(pad, MARKER);
        if (isMap && (/\.voor-beleid/.test(naam) || existsSync(marker))) regels.push(`drift ${pad}: onbeheerde beheerde skillmap`);
        else regels.push(`info onbeheerd ${naam}`);
      }
    }
    return regels;
  }
  for (const [bron, doel] of bronnen) plan(bron, doel, !!o.droog, regels);
  if (o.droog) return regels;
  const ouder = dirname(o.doel); mkdirSync(ouder, { recursive: true });
  const staging = mkdtempSync(join(ouder, `.${basename(o.doel)}.beleid-staging-`));
  try {
    const staged = bronnen.map(([bron, doel]) => [bron, doel, join(staging, basename(doel))] as const);
    for (const [bron, , stageDoel] of staged) { deps.voorStageer?.(bron); stageer(bron, stageDoel); }
    mkdirSync(o.doel, { recursive: true });
    const backupMap = join(ouder, ".lab-beleid-backups");
    for (const [, doel, stageDoel] of staged) vervang(stageDoel, doel, backupMap);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return regels;
}
if (import.meta.main) {
  const a = process.argv.slice(2); const i = a.indexOf("--doel"); const doel = i < 0 ? undefined : a[i + 1];
  if (i < 0 || !doel || a.some((v, n) => !["--doel", "--droog", "--controle"].includes(v) && n !== i + 1)) throw new Error("gebruik: --doel <map> [--droog] [--controle]");
  const controle = a.includes("--controle");
  const regels = installeer({ doel, droog: a.includes("--droog"), controle });
  for (const r of regels) console.log(`${a.includes("--droog") ? "DROOG" : controle ? "CONTROLE" : "OK"} ${r}`);
  if (controle && regels.some((r) => r.startsWith("drift "))) process.exit(1);
}
