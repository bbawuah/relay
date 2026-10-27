import { describe, expect, test } from "bun:test";
import { draaiDemo } from "./demo";

describe("e2e-demo van de peerbus", () => {
  test("alle controles zijn groen en de wegwerp-tmux is daarna weg", async () => {
    const d = await draaiDemo();
    expect(d.controles.filter((c) => !c.ok)).toEqual([]);
    expect(d.controles.length).toBeGreaterThanOrEqual(15);
    expect(d.ok).toBe(true);
    const ls = Bun.spawnSync(["tmux", "-L", `peerbus-e2e-${process.pid}`, "ls"], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    expect(ls.exitCode).not.toBe(0);
  }, 30_000);
});
