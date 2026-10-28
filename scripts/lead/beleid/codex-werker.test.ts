import { describe, expect, test } from "bun:test";
import { CODEX_WERKER_BUN_INSTALL_ARGS } from "./codex-werker";

describe("Codex-werkerbeleid", () => {
  // test-weg: filesystemprofiel vervalt; runtimebeleid komt uit CODEX_HOME.
  // test-weg: netwerkprofiel vervalt; de installatie blijft afzonderlijk getest.
  test("houdt alleen het expliciete installatiecontract over", () => {
    expect(CODEX_WERKER_BUN_INSTALL_ARGS).toEqual(["install", "--ignore-scripts", "--frozen-lockfile"]);
  });
});
