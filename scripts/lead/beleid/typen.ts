// Typen voor optionele eventconfiguratie. Rollen en commandoregels zijn gepensioneerd.

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
  script: "lead-hook" | "werknotities-pre" | "werknotities-post" | "tmux-status" | "pane-info-clear";
  timeoutS: number;
  /** Ontbreekt = alle hosts waar het vertaalt. */
  hosts?: Host[];
  /** Pad; ontbreekt het, dan slaat de generator de hook over met een melding. */
  alsBestaat?: string;
};
export type McpServer = { id: string; command: "bun"; script: string; env?: Record<string, string> };
/** De lege legacy velden blijven beschikbaar voor bestaande eventconfiguratiecallers. */
export type Beleid = { hooks: Hook[]; regels: never[]; env: Record<string, string>; mcp: McpServer[]; rollen: never[] };
