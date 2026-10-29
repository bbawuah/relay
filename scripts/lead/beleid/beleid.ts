// Optionele eventconfiguratie voor sessiestatus en peerberichten; geen permission- of rolbeleid.
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
  ],
  regels: [],
  env: {},
  mcp: [],
  rollen: [],
};
