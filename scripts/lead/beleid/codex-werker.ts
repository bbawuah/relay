// Het expliciete installatiecontract voor Codex-werkers. Runtimebeleid komt
// uit het gekozen CODEX_HOME, net als bij Claude-werkers.
export const CODEX_WERKER_BUN_INSTALL_ARGS = ["install", "--ignore-scripts", "--frozen-lockfile"] as const;

if (import.meta.main) {
  const [actie, ...args] = process.argv.slice(2);
  if (actie === "bun-install-args" && args.length === 0) {
    process.stdout.write(`${CODEX_WERKER_BUN_INSTALL_ARGS.join("\n")}\n`);
  } else {
    process.stderr.write("codex-werkerbeleid: gebruik: bun-install-args\n");
    process.exit(1);
  }
}
