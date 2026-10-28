import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const conf = join(import.meta.dir, "vendor.conf");
const inCodexSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const tmuxBeschikbaar = Bun.which("tmux") !== null;

test("vendor.conf houdt Claude-details, vendor-kleuren en de command-terugval", () => {
  const inhoud = readFileSync(conf, "utf8");
  expect(inhoud).toContain("@vendor");
  expect(inhoud).toContain("@agent_naam");
  expect(inhoud).toContain("@claude_model");
  expect(inhoud).toContain("claude.exe");
  expect(inhoud).toContain("codex");
  expect(inhoud).toMatch(/pane-active-border-style.*#d97757/);
  expect(inhoud).toMatch(/pane-active-border-style.*#10a37f/);
});

// test-weg: scripts/lead/tmux/vendor.test.ts: CI-images zonder tmux kunnen de 3.7c-config niet laden; de inhoudstest blijft draaien.
test.skipIf(inCodexSandbox || !tmuxBeschikbaar)("vendor.conf laadt in een wegwerp-tmux met tmux 3.7c", () => {
  const sok = `test-h-vendor-${process.pid}-${Date.now()}`;
  const tmux = (...args: string[]) => Bun.spawnSync(["tmux", "-L", sok, "-f", conf, ...args], { env: { ...process.env, TMUX: "", TMUX_PANE: "" } });
  try {
    expect(tmux("start-server").exitCode).toBe(0);
    expect(tmux("new-session", "-d", "-s", "vendor", "sleep 20").exitCode).toBe(0);
    expect(tmux("show-options", "-g", "pane-border-format").stdout.toString()).toContain("@vendor");
  } finally {
    tmux("kill-server");
  }
});
