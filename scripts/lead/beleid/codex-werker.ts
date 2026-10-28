// Eén bron voor het sandboxprofiel van een Codex-werker.
//
// spawn.sh gebruikt `spawnCArgs` woordelijk als zijn drie -c-waarden. Een eigen
// CODEX_HOME gebruikt `configBlok`: T3 voegt de worktree-schrijfbaarheid per
// runtime mode toe, maar krijgt dezelfde denylist en CODEX_HOME-allowlist.

export type CodexWerkerOpties = {
  home: string;
  codexHome: string;
  netwerk: boolean;
  worktree?: string;
  gitCommon?: string;
  gitDir?: string;
  tmp?: string;
  naam?: string;
};

export const CODEX_WERKER_BUN_INSTALL_ARGS = ["install", "--ignore-scripts", "--frozen-lockfile"] as const;
const CODEX_ALLOWLIST = ["shell_snapshots", "skills", "prompts", "rules", "AGENTS.md", "packages"] as const;
const SLEUTELMAPS = [
  ".config/klaarover", ".config/douane", ".config/agentwerkbank",
  ".ssh", ".config/gh", ".netrc", ".git-credentials", ".aws", ".azure", ".kube", ".docker", ".npmrc", ".config/op",
  "Library/Keychains", ".config/glab-cli", ".gnupg", ".config/gcloud", "Library/Application Support/com.vercel.cli",
  ".claude/projects", ".claude/.credentials.json", ".claude/history.jsonl", ".claude.json",
] as const;

const regel = (pad: string, toegang: "read" | "write" | "none") => `"${pad}"="${toegang}"`;
const pad = (thuis: string, deel: string) => `${thuis}/${deel}`;

/** De gedeelde denylist, gevolgd door de noodzakelijke uitzonderingen onder beide Codex-homes. */
function gedeeldeLeesRegels(o: Pick<CodexWerkerOpties, "home" | "codexHome">): string[] {
  const uit = SLEUTELMAPS.slice(0, 3).map((d) => regel(pad(o.home, d), "none"));
  for (const d of [o.codexHome, pad(o.home, ".codex")]) {
    uit.push(regel(d, "none"));
    for (const a of CODEX_ALLOWLIST) uit.push(regel(`${d}/${a}`, "read"));
    if (d === pad(o.home, ".codex")) break;
  }
  for (const d of SLEUTELMAPS.slice(3)) uit.push(regel(pad(o.home, d), "none"));
  return uit;
}

/** De geordende filesystem-map voor spawn. Volgorde is een compatibiliteitscontract met de bestaande CLI-uitvoer. */
export function spawnFilesystem(o: Required<CodexWerkerOpties>): string {
  const uit = [
    regel("/", "read"), regel(o.worktree, "write"), regel(`${o.gitCommon}/objects`, "write"), regel(`${o.gitCommon}/refs`, "write"), regel(`${o.gitCommon}/logs`, "write"),
    regel(o.gitDir, "write"), regel(`${o.gitDir}/commondir`, "read"), regel(`${o.gitDir}/gitdir`, "read"), regel(`${o.gitDir}/config.worktree`, "read"), regel(`${o.gitDir}/HEAD`, "read"),
    regel(`${o.gitCommon}/refs/replace`, "read"), regel(`${o.worktree}/.git`, "read"), regel(`${o.tmp}/lab-werker-${o.naam}`, "write"),
  ];
  if (o.netwerk) uit.push(regel(`${o.home}/.bun/install/cache`, "write"));
  uit.push(regel(`${o.worktree}/.codex`, "read"), ...gedeeldeLeesRegels(o));
  return uit.join(",");
}

/** De drie -c-waarden, precies in de bestaande spawn-volgorde. */
export function spawnCArgs(o: Required<CodexWerkerOpties>): string[] {
  return [
    'default_permissions="lab-werker"',
    `permissions.lab-werker.filesystem={${spawnFilesystem(o)}}`,
    `permissions.lab-werker.network={enabled=${o.netwerk ? "true" : "false"}}`,
  ];
}

/** Config-fragment voor een eigen CODEX_HOME (bijvoorbeeld de T3 Codex-lab-instantie). */
export function configBlok(o: Pick<CodexWerkerOpties, "home" | "codexHome">): string {
  const regels = [regel("/", "read"), ...gedeeldeLeesRegels(o)];
  return [
    'default_permissions = "lab-werker"',
    "",
    "[permissions.lab-werker]",
    `filesystem = { ${regels.join(",")} }`,
    "network = { enabled = false }",
    "",
  ].join("\n");
}

function vereis(args: string[], aantal: number): void {
  if (args.length !== aantal || args.some((a) => !a || /['"\\\n\r]/.test(a))) throw new Error("ongeldige of onveilige profielargumenten");
}

if (import.meta.main) {
  const [actie, ...args] = process.argv.slice(2);
  try {
    if (actie === "spawn-c-args") {
      vereis(args, 8);
      const [worktree, gitCommon, gitDir, home, tmp, naam, codexHome, netwerk] = args;
      if (netwerk !== "true" && netwerk !== "false") throw new Error("netwerk moet true of false zijn");
      process.stdout.write(`${spawnCArgs({ worktree, gitCommon, gitDir, home, tmp, naam, codexHome, netwerk: netwerk === "true" }).join("\n")}\n`);
    } else if (actie === "config-blok") {
      vereis(args, 2);
      process.stdout.write(configBlok({ home: args[0]!, codexHome: args[1]! }));
    } else if (actie === "bun-install-args") {
      process.stdout.write(`${CODEX_WERKER_BUN_INSTALL_ARGS.join("\n")}\n`);
    } else {
      throw new Error("gebruik: spawn-c-args|config-blok|bun-install-args");
    }
  } catch (e) {
    process.stderr.write(`codex-werkerprofiel: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
