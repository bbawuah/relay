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
function plan(bron: string, doel: string, droog: boolean, regels: string[]) {
  regels.push(`${existsSync(doel) ? "vervang" : "installeer"} ${doel}`);
  if (droog) { if (existsSync(join(doel, "SKILL.md")) && readFileSync(join(bron, "SKILL.md"), "utf8") !== readFileSync(join(doel, "SKILL.md"), "utf8")) regels.push(`--- ${join(doel, "SKILL.md")}\n+++ ${join(bron, "SKILL.md")}\n- ${readFileSync(join(doel, "SKILL.md"), "utf8").trim()}\n+ ${readFileSync(join(bron, "SKILL.md"), "utf8").trim()}`); return; }
}
function stageer(bron: string, doel: string) {
  cpSync(bron, doel, { recursive: true, filter: (p) => !p.endsWith(".system") && !p.includes("/synced/") });
  writeFileSync(join(doel, MARKER), JSON.stringify({ bron: "beleid" }) + "\n", { mode: 0o600 });
}
function vervang(staging: string, doel: string, backupMap: string) {
  if (existsSync(doel)) { const back = join(backupMap, basename(doel)); rmSync(back, { recursive: true, force: true }); mkdirSync(backupMap, { recursive: true }); renameSync(doel, back); }
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
  if (controle && regels.length) process.exit(1);
}
