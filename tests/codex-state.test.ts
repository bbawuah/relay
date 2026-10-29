import { expect, test } from "bun:test";
import { maakBlok, leesArgs } from "../scripts/lead/hooks/codex-installeer";
import { genereer } from "../scripts/lead/beleid/claude";
import { beleid } from "../scripts/lead/beleid/beleid";

test("Codex hooks use the selected Relay state even in a previously started daemon", () => {
  const options = leesArgs(["--staat", "/tmp/relay state"], { HOME: "/tmp/home" }, "/tmp/source");
  expect(typeof options).toBe("object");
  if (typeof options === "string") throw new Error(options);
  const hooks = Bun.TOML.parse(maakBlok(options)) as any;
  for (const groups of Object.values(hooks.hooks) as any[]) {
    expect(groups[0].hooks[0].command).toContain("LAB_LEAD_STAAT='/tmp/relay state'");
  }
});

test("Claude hooks, including the optional wake-up hook, pin the chosen state", () => {
  const generated = genereer(beleid, "claude", { doel: "/tmp/hooks/lab-lead-hooks", bun: "/tmp/bun", staat: "/tmp/relay state", metWekker: true, verwijder: false, settings: "/tmp/settings.json" });
  const groups = Object.values(JSON.parse(generated.bestanden[0]!.inhoud).hooks) as any[];
  for (const eventGroups of groups) for (const group of eventGroups) for (const hook of group.hooks) expect(hook.command).toContain("LAB_LEAD_STAAT='/tmp/relay state'");
});
