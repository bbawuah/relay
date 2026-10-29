import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Environment = Record<string, string | undefined>;

/** Keep the existing wire format and LAB_* names interoperable during migration. */
export function environment(input: Environment = process.env): Environment {
  const env = { ...input };
  for (const [relay, legacy] of [
    ["RELAY_NAME", "LAB_AGENT_NAAM"],
    ["RELAY_LEAD", "LAB_LEAD_NAAM"],
    ["RELAY_ROLE", "LAB_AGENT_ROL"],
    ["RELAY_STATE_DIR", "LAB_LEAD_STAAT"],
  ]) {
    if (input[relay]) env[legacy!] = input[relay];
  }
  env.LAB_LEAD_STAAT = resolve(env.LAB_LEAD_STAAT || join(input.HOME || homedir(), ".local", "state", "relay"));
  // Environment injection is separate from startup config; use bunArgs as well.
  delete env.BUN_OPTIONS;
  delete env.NODE_OPTIONS;
  return env;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
