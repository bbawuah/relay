// De bron van de beleidslaag (fase 1): wat Claude vandaag krijgt. Geen geheimen in `env` of `mcp[].env`
// (de poorttest beleid.test.ts weigert sleutelvormen).
//
// - lead-hooks: één hook per event, gelijk aan wat installeer-hooks.ts altijd installeerde.
// - grenzen: de PreToolUse-hook die Brian nu met de hand in settings.json heeft staan; de installer
//   zet hem in fase 1 nog niet (zie claude.ts, optie `metGrenzen`), zodat er niets verandert.

import type { Beleid } from "./typen";

export const beleid: Beleid = {
  hooks: [
    { id: "lead-sessie-start", event: "sessie-start", script: "lead-hook", timeoutS: 5 },
    { id: "lead-prompt", event: "prompt", script: "lead-hook", timeoutS: 5 },
    { id: "lead-voor-tool", event: "voor-tool", tools: ["alle"], script: "lead-hook", timeoutS: 5 },
    // SendMessage en peers.send zijn het rapport (H4); WebFetch, WebSearch en MCP-tools zetten de herkomst op extern.
    { id: "lead-na-tool", event: "na-tool", tools: ["bericht", "web", "mcp"], script: "lead-hook", timeoutS: 5 },
    { id: "lead-melding", event: "melding", script: "lead-hook", timeoutS: 5 },
    { id: "lead-stop", event: "stop", script: "lead-hook", timeoutS: 5 },
    { id: "lead-stop-fout", event: "stop-fout", script: "lead-hook", timeoutS: 5 },
    { id: "lead-subagent-start", event: "subagent-start", script: "lead-hook", timeoutS: 5 },
    { id: "lead-subagent-stop", event: "subagent-stop", script: "lead-hook", timeoutS: 5 },
    { id: "lead-sessie-einde", event: "sessie-einde", script: "lead-hook", timeoutS: 1 },
    { id: "grenzen", event: "voor-tool", tools: ["shell", "lezen"], script: "grenzen", timeoutS: 5, hosts: ["claude"] },
  ],
  regels: [],
  env: {},
  mcp: [],
  rollen: [],
};
