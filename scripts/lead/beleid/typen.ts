// De typen van de beleidslaag (CONTRACT-beleidslaag.md, bindend; wijzigen alleen via de lead).

export type Event =
  | "sessie-start"
  | "prompt"
  | "voor-tool"
  | "na-tool"
  | "stop"
  | "sessie-einde"
  | "compact-voor"
  | "compact-na"
  | "toestemming"
  | "subagent-stop"
  | "subagent-start"
  | "stop-fout"
  | "melding";
export type ToolKlasse = "shell" | "schrijven" | "lezen" | "mcp" | "web" | "bericht" | "alle";
export type Host = "claude" | "codex";
export type Hook = {
  /** Stabiel, uniek; basis van de markering. */
  id: string;
  event: Event;
  /** Alleen voor voor-tool/na-tool; ontbreekt = alle. */
  tools?: ToolKlasse[];
  script: "lead-hook" | "grenzen" | "werknotities-pre" | "werknotities-post" | "tmux-status" | "pane-info-clear";
  timeoutS: number;
  /** Ontbreekt = alle hosts waar het vertaalt. */
  hosts?: Host[];
  /** Pad; ontbreekt het, dan slaat de generator de hook over met een melding. */
  alsBestaat?: string;
};
export type CommandoRegel = { id: string; prefix: string[][]; besluit: "vraag" | "weiger"; reden: string };
export type McpServer = { id: string; command: "bun"; script: string; env?: Record<string, string> };
export type RolStandaard = { rol: "werker"; webSearch: "uit"; sandbox: "lab-werker"; netwerk: "uit" | "aan" };
export type Beleid = { hooks: Hook[]; regels: CommandoRegel[]; env: Record<string, string>; mcp: McpServer[]; rollen: RolStandaard[] };
