/**
 * Arguments after the Bun executable for a trusted Relay helper. Keep the
 * caller's cwd: it identifies the session, but must not configure the runtime.
 * Use --config=PATH (the separated form does not suppress cwd bunfig preloads).
 * Pin tsconfig too: cwd paths mappings can redirect even an absolute entrypoint.
 * /dev/null is an empty, system-owned config, also available to copied hooks.
 */
export function bunArgs(script: string, args: string[] = []): string[] {
  return ["--config=/dev/null", "--tsconfig-override=/dev/null", "--no-env-file", "--no-macros", "--no-install", script, ...args];
}
