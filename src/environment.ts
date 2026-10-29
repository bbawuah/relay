import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Environment = Record<string, string | undefined>;

/** Message v2 uses explicit Relay settings, never legacy roles or cwd. */
export function environment(input: Environment = process.env): Environment {
  const env = { ...input };
  env.RELAY_STATE_DIR = resolve(input.RELAY_STATE_DIR || join(input.HOME || homedir(), ".local", "state", "relay", "v2"));
  env.RELAY_NAMESPACE = input.RELAY_NAMESPACE ?? "local";
  // Environment injection is separate from startup config; use bunArgs as well.
  delete env.BUN_OPTIONS;
  delete env.NODE_OPTIONS;
  return env;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
