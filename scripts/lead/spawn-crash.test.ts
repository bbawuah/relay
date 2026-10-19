import { expect, test } from "bun:test";
import { isStartCrash, metStartHerstel, stopReden, type Resultaat } from "./spawn-crash.ts";

const leeg = { length: 0 };
const crash: Resultaat = { exitCode: null, signalCode: "SIGTRAP", stdout: leeg, stderr: leeg };
const ok: Resultaat = { exitCode: 0, signalCode: null, stdout: { length: 5 }, stderr: leeg };

test("een start-crash (signaal, geen uitvoer) wordt eenmaal herhaald", () => {
  const reeks = [crash, ok];
  let n = 0;
  const { r, pogingen } = metStartHerstel(() => reeks[n++]!);
  expect(pogingen).toBe(2);
  expect(r.exitCode).toBe(0);
});

test("een tweede crash blijft een fout, er is geen derde poging", () => {
  let n = 0;
  const { r, pogingen } = metStartHerstel(() => (n++, crash));
  expect(n).toBe(2);
  expect(pogingen).toBe(2);
  expect(r.exitCode).toBeNull();
});

test("geen herhaling bij SIGKILL, bij uitvoer of bij een gewone exitcode", () => {
  expect(isStartCrash({ ...crash, signalCode: "SIGKILL" })).toBe(false);
  expect(isStartCrash({ ...crash, stderr: { length: 3 } })).toBe(false);
  expect(isStartCrash({ ...ok, exitCode: 1 })).toBe(false);
  let n = 0;
  metStartHerstel(() => (n++, { ...ok, exitCode: 3 }));
  expect(n).toBe(1);
});

test("de reden noemt het signaal", () => {
  expect(stopReden(crash)).toBe("kindproces gedood door signaal SIGTRAP");
  expect(stopReden(ok)).toBe("exit 0");
});
