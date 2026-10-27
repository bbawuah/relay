// Vertaaltabel per host (CONTRACT-beleidslaag.md). `null` = niet vertaalbaar: de generator geeft dan een
// waarschuwing met de reden, nooit stil weglaten. De Codex-kolom volgt in fase 2.

import type { Event, Host, ToolKlasse } from "./typen";

export type HostTabel = {
  events: Record<Event, string | null>;
  tools: Record<ToolKlasse, string | null>;
  /** Matcher van een event dat geen tool is (bv. SessionStart, Notification). */
  eventMatcher: Partial<Record<Event, string>>;
  /** Wat nooit vertaalt en altijd genoemd wordt. */
  nietVertaalbaar: string[];
};

export const hosts: Record<Host, HostTabel | null> = {
  claude: {
    events: {
      "sessie-start": "SessionStart",
      prompt: "UserPromptSubmit",
      "voor-tool": "PreToolUse",
      "na-tool": "PostToolUse",
      stop: "Stop",
      "sessie-einde": "SessionEnd",
      "compact-voor": "PreCompact",
      "compact-na": "PostCompact",
      toestemming: "PermissionRequest",
      "subagent-stop": "SubagentStop",
      "subagent-start": "SubagentStart",
      "stop-fout": "StopFailure",
      melding: "Notification",
    },
    tools: {
      shell: "Bash",
      schrijven: "Write|Edit|MultiEdit",
      lezen: "Read|Grep|Glob|NotebookRead",
      mcp: "mcp__.*",
      web: "WebFetch|WebSearch",
      bericht: "SendMessage",
      alle: "*",
    },
    eventMatcher: { "sessie-start": "startup|clear|resume", melding: "permission_prompt|idle_prompt" },
    nietVertaalbaar: ["Claude `autoMode` (classifier) heeft geen neutraal equivalent en blijft van Brian"],
  },
  codex: null,
};
