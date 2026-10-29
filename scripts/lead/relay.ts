#!/usr/bin/env bun
// relay: één dunne ingang voor de bestaande lead-scripts.
// De repo-wortel volgt altijd uit dit bestand; daarmee verhuist deze dispatcher
// zonder persoonlijke LAB-paden mee naar de toekomstige relay-repository.
import path from "node:path";

export const repoWortel = (scriptMap = import.meta.dir): string => path.resolve(scriptMap, "..", "..");

type Uitvoerder = (argv: string[], cwd: string, env?: Record<string, string | undefined>) => Promise<number>;
type Opties = { root?: string; cwd?: string; uitvoer?: Uitvoerder };

const gebruik = `Gebruik:
  relay claude -l
  relay codex [prompt]
  relay codex -l [prompt]       # compatibele alias
  relay claude|codex -w <naam> <opdracht> [--map <map>]
  relay ls
  relay send <naam> <tekst>
  relay status`;

const naamGeldig = (naam: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(naam);

export function kindOmgeving(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const omgeving = { ...process.env, ...extra };
  // Een bunfig-preload van de aanroeper mag geen kindproces buiten het beleid
  // laten lezen; hetzelfde geldt voor Node-preloads in alle relay-routes.
  delete omgeving.BUN_OPTIONS;
  delete omgeving.NODE_OPTIONS;
  return omgeving;
}

async function echtUitvoeren(argv: string[], cwd: string, env?: Record<string, string | undefined>): Promise<number> {
  const kind = Bun.spawn(argv, { cwd, env: kindOmgeving(env), stdio: ["inherit", "inherit", "inherit"] });
  const code = await kind.exited;
  return kind.signalCode ? 128 : code;
}

function fout(tekst: string): number {
  console.error(`relay: ${tekst}`);
  return 2;
}

function pad(root: string, relatief: string): string {
  return path.join(root, relatief);
}

function werkerArgs(vendor: string, args: string[]): string[] | string {
  const [naam, opdracht, ...rest] = args;
  if (!naam || !opdracht) return "-w vraagt <naam> en <opdracht>";
  if (!naamGeldig(naam)) return `ongeldige naam: ${naam}`;
  if (rest.length === 0) return ["--vendor", vendor, "--naam", naam, "--opdracht", opdracht];
  if (rest.length === 2 && rest[0] === "--map" && rest[1] && !rest[1].startsWith("-")) {
    return ["--vendor", vendor, "--naam", naam, "--opdracht", opdracht, "--map", rest[1]];
  }
  return "alleen --map <map> is toegestaan naast -w; spawn.sh bewaakt de overige opties";
}

/** Draait één relay-opdracht. `root` en `uitvoer` zijn uitsluitend injectiepunten voor de tests. */
export async function draai(args: string[], opties: Opties = {}): Promise<number> {
  const root = opties.root ?? repoWortel();
  const cwd = opties.cwd ?? process.cwd();
  const run = opties.uitvoer ?? echtUitvoeren;
  const voerUit = (argv: string[], env?: Record<string, string | undefined>) => run(argv, cwd, kindOmgeving(env));
  const [vendorOfOpdracht, vorm, ...rest] = args;
  const spawn = pad(root, "scripts/lead/spawn.sh");
  const codexLead = pad(root, "scripts/lead/lead-codex-auto.sh");
  const peers = pad(root, "scripts/lead/peers/cli.ts");
  const status = pad(root, "scripts/lead/status.sh");

  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(gebruik);
    return 0;
  }

  if (vendorOfOpdracht === "claude" || vendorOfOpdracht === "codex") {
    // Codex is de natuurlijke standaard van Relay: geen vlag en geen vooraf
    // geschreven opdrachtbestand zijn nodig om een lead-sessie te openen.
    // Houd `-l` als leesbare, achterwaarts compatibele alias.
    if (vendorOfOpdracht === "codex" && vorm !== "-w") {
      const prompt = vorm === "-l" ? rest : args.slice(1);
      if (prompt.length > 1 || prompt[0]?.startsWith("-")) return fout("codex staat hoogstens één gewone prompt toe");
      // Buiten een project mag de korte route gewoon een Relay-lead openen.
      // De helper gebruikt deze checkout dan als veilige terugval-worktree.
      return voerUit(["bash", codexLead, ...prompt], { LAB_RELAY_ROOT: root });
    }
    if (vorm === "-w") {
      const werk = werkerArgs(vendorOfOpdracht, rest);
      return typeof werk === "string" ? fout(werk) : voerUit(["bash", spawn, ...werk]);
    }
    if (vorm !== "-l") return fout(`${vendorOfOpdracht} verwacht -l of -w\n${gebruik}`);
    // De Claude-lead heeft nog geen starter-script. Dit is precies de gedocumenteerde
    // startregel (README.md), zonder extra policy of tmux-route toe te voegen.
    if (rest.length) return fout("claude -l neemt geen extra argumenten");
    const naam = process.env.LAB_AGENT_NAAM ?? "";
    const lead = process.env.LAB_LEAD_NAAM ?? naam;
    if (!naamGeldig(naam) || lead !== naam) return fout("claude -l vereist gelijke, geldige LAB_AGENT_NAAM en LAB_LEAD_NAAM");
    return voerUit(["claude", "-n", naam], { LAB_LEAD: "1", LAB_AGENT_ROL: "lead", LAB_AGENT_NAAM: naam, LAB_LEAD_NAAM: naam });
  }

  if (vendorOfOpdracht === "send") {
    if (vorm === undefined || rest.length !== 1) return fout(`send verwacht <naam> <tekst>\n${gebruik}`);
    return voerUit([process.execPath, peers, "send", vorm, rest[0]!]);
  }
  if (vendorOfOpdracht === "ls") {
    if (vorm !== undefined) return fout(`ls heeft geen argumenten\n${gebruik}`);
    const code = await voerUit([process.execPath, peers, "list"]);
    return code === 0 ? voerUit(["bash", status, "--git"]) : code;
  }
  if (vendorOfOpdracht === "status") {
    if (vorm !== undefined) return fout(`status heeft geen argumenten\n${gebruik}`);
    const sporen = await voerUit(["bash", status, "--json", "--git"]);
    if (sporen !== 0) return sporen;
    // `gh pr list` leest alleen open PR's; de takken staan al in status.sh --git.
    return voerUit(["gh", "pr", "list", "--state", "open", "--limit", "20"]);
  }
  return fout(gebruik);
}

if (import.meta.main) process.exit(await draai(process.argv.slice(2)));
