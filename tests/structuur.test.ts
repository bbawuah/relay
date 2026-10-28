import { expect, test } from "bun:test";
import { existsSync } from "node:fs";

test("relay bevat de grenzen- en lead-hooks", () => {
  for (const pad of ["scripts/lead/hooks/grenzen.sh", "scripts/lead/hooks/hook.sh"]) expect(existsSync(pad)).toBe(true);
});
