import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MARKER = ".lab-beleid-skill.json";
export const REPO_SKILLS = ["lead", "retro", "grill-me"] as const;
export const LOKALE_SKILLS = ["naar-mod", "tailnet", "vault", "scrawl"] as const;

export type Opties = { doel: string; repo?: string; lokaal?: string; droog?: boolean; controle?: boolean };
const veilig = (n: string) => /^[a-z][a-z0-9-]*$/.test(n) && n !== ".system" && n !== "synced";
function geenSymlink(p: string): void { const s = lstatSync(p); if (s.isSymbolicLink()) throw new Error(`${p}: symlinks zijn niet toegestaan`); if (s.isDirectory()) for (const e of readdirSync(p)) geenSymlink(join(p, e)); }
function kopieer(bron: string, doel: string, droog: boolean, regels: string[]) {
  if (!existsSync(join(bron, "SKILL.md"))) throw new Error(`${bron}: SKILL.md ontbreekt`);
  geenSymlink(bron);
  if (lstatSync(bron).isSymbolicLink() || lstatSync(join(bron, "SKILL.md")).isSymbolicLink()) throw new Error(`${bron}: symlinks zijn niet toegestaan`);
  if (existsSync(doel) && (!existsSync(join(doel, MARKER)) || lstatSync(join(doel, MARKER)).isSymbolicLink())) throw new Error(`${doel}: niet door beleid gemarkeerd of marker is symlink`);
  regels.push(`${existsSync(doel) ? "vervang" : "installeer"} ${doel}`);
  if (droog) { if (existsSync(join(doel, "SKILL.md")) && readFileSync(join(bron, "SKILL.md"), "utf8") !== readFileSync(join(doel, "SKILL.md"), "utf8")) regels.push(`--- ${join(doel, "SKILL.md")}\n+++ ${join(bron, "SKILL.md")}\n- ${readFileSync(join(doel, "SKILL.md"), "utf8").trim()}\n+ ${readFileSync(join(bron, "SKILL.md"), "utf8").trim()}`); return; }
  if (existsSync(doel)) { const back = `${doel}.voor-beleid`; rmSync(back, { recursive: true, force: true }); renameSync(doel, back); }
  mkdirSync(doel, { recursive: true });
  cpSync(bron, doel, { recursive: true, filter: (p) => !p.endsWith(".system") && !p.includes("/synced/") });
  writeFileSync(join(doel, MARKER), JSON.stringify({ bron: "beleid" }) + "\n", { mode: 0o600 });
}
export function installeer(o: Opties) {
  const repo = o.repo ?? join(import.meta.dir, "../../..", "agents/skills");
  const lokaal = o.lokaal ?? join(process.env.HOME ?? "", "vault-b-status/skills");
  const regels: string[] = [];
  const bronnen = [...REPO_SKILLS.map((n) => [join(repo, n), join(o.doel, n)] as const), ...LOKALE_SKILLS.filter((n) => veilig(n) && existsSync(join(lokaal, n))).map((n) => [join(lokaal, n), join(o.doel, n)] as const)];
  // Alles vooraf: een kapotte latere skill mag nooit een eerdere doelmap vervangen.
  for (const [bron, doel] of bronnen) { if (!existsSync(join(bron, "SKILL.md"))) throw new Error(`${bron}: SKILL.md ontbreekt`); geenSymlink(bron); if (existsSync(doel) && (!existsSync(join(doel, MARKER)) || lstatSync(join(doel, MARKER)).isSymbolicLink())) throw new Error(`${doel}: niet door beleid gemarkeerd of marker is symlink`); }
  for (const [bron, doel] of bronnen) kopieer(bron, doel, !!o.droog, regels);
  if (o.controle) for (const n of readdirSync(o.doel, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) if ((REPO_SKILLS as readonly string[]).includes(n) && !existsSync(join(o.doel, n, MARKER))) throw new Error(`${n}: marker ontbreekt`);
  return regels;
}
if (import.meta.main) {
  const a = process.argv.slice(2); const i = a.indexOf("--doel"); const doel = i < 0 ? undefined : a[i + 1];
  if (i < 0 || !doel || a.some((v, n) => !["--doel", "--droog", "--controle"].includes(v) && n !== i + 1)) throw new Error("gebruik: --doel <map> [--droog] [--controle]");
  for (const r of installeer({ doel, droog: a.includes("--droog"), controle: a.includes("--controle") })) console.log(`${a.includes("--droog") ? "DROOG" : "OK"} ${r}`);
}
