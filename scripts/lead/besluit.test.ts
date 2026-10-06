import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { leesBesluit } from "../../apps/tmux/server/besluiten";
import { controle, leesArgs, leesEen, lijstRegels, maakBesluit, passkeyActies, schrijfNieuw } from "./besluit";

const dir = mkdtempSync(path.join(tmpdir(), "besluit-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const SCRIPT = path.join(import.meta.dir, "besluit.ts");

const args = ["--id", "hook-plek", "--titel", "Compactie-hook op één plek", "--vraag", "Hook naar settings?", "--optie", "ja=Akkoord", "--optie", "nee=Niet doen", "--passkey"];

describe("besluit.ts", () => {
  test("args: values, the flag and repeated options", () => {
    expect(leesArgs(["nieuw", ...args])).toEqual({
      pos: ["nieuw"],
      o: { id: "hook-plek", titel: "Compactie-hook op één plek", vraag: "Hook naar settings?", optie: ["ja=Akkoord", "nee=Niet doen"], passkey: true },
    });
    expect(() => leesArgs(["--id"])).toThrow("mist een waarde");
  });

  test("a new decision passes the server's schema; the proposal defaults to the first option", () => {
    const b = maakBesluit(leesArgs(args).o, new Date("2026-10-06T10:38:00Z"));
    expect(b).toMatchObject({ id: "hook-plek", voorstel: "ja", passkey: true, tijd: "2026-10-06T10:38:00.000Z" });
    expect(leesBesluit(b)).toEqual(b);
  });

  test("invalid input is refused with the rules", () => {
    expect(() => maakBesluit(leesArgs([...args, "--id", "../weg"]).o)).toThrow("Ongeldig besluit");
    expect(() => maakBesluit(leesArgs(["--id", "x-1", "--titel", "t", "--vraag", "v", "--optie", "ja=A"]).o)).toThrow("Ongeldig besluit");
    expect(() => maakBesluit(leesArgs([...args, "--voorstel", "misschien"]).o)).toThrow("Ongeldig besluit");
    expect(() => maakBesluit(leesArgs(["--optie", "geenis"]).o)).toThrow("id=label");
  });

  test("written 600 in a 700 folder; never overwritten; read and listed back", () => {
    const map = path.join(dir, "besluiten");
    const b = maakBesluit(leesArgs(args).o);
    const pad = schrijfNieuw(map, b);
    expect(statSync(pad).mode & 0o777).toBe(0o600);
    expect(statSync(map).mode & 0o777).toBe(0o700);
    expect(() => schrijfNieuw(map, b)).toThrow();
    expect(leesEen(map, "hook-plek")).toEqual(b);
    expect(leesEen(map, "../hook-plek")).toBeNull();
    writeFileSync(path.join(map, "kapot.json"), "{");
    const keuze = { ...b, id: "al-klaar", keuze: { optie: "nee", toelichting: "later", door: "iphone", tijd: "2026-10-06T11:00:00Z" } };
    writeFileSync(path.join(map, "al-klaar.json"), JSON.stringify(keuze));
    expect(lijstRegels(map)).toEqual([
      "ONBEVESTIGD al-klaar  → nee (met toelichting)  Compactie-hook op één plek  [geen passkey in het auditlog]",
      "open      hook-plek  Compactie-hook op één plek  [passkey]",
      "ongeldig  kapot.json",
    ]);
  });

  test("a passkey choice counts only with its audit line: same decision, same device, just before", () => {
    const b = maakBesluit(leesArgs(args).o);
    const gekozen = { ...b, keuze: { optie: "ja", door: "iphone-1", tijd: "2026-10-06T11:00:00.000Z" } };
    const regel = (v: object) => JSON.stringify({ tijd: "2026-10-06T10:59:30.000Z", gebeurtenis: "passkey-actie", login: "x", apparaat: "iphone-1", doel: "besluit:hook-plek", ok: true, ...v });
    const met = (...r: string[]) => controle(gekozen, passkeyActies(["kapot{", ...r].join("\n")));
    expect(met(regel({}))).toBe("bevestigd");
    expect(met()).toBe("onbevestigd");
    expect(met(regel({ ok: false }))).toBe("onbevestigd");
    expect(met(regel({ doel: "besluit:ander" }))).toBe("onbevestigd");
    expect(met(regel({ apparaat: "ipad-1" }))).toBe("onbevestigd");
    expect(met(regel({ tijd: "2026-10-06T11:00:01.000Z" }))).toBe("onbevestigd"); // after the choice
    expect(met(regel({ tijd: "2026-10-06T10:40:00.000Z" }))).toBe("onbevestigd"); // too long before
    expect(met(regel({ gebeurtenis: "besluit" }))).toBe("onbevestigd");
    expect(controle({ ...gekozen, passkey: false }, [])).toBe("bevestigd");
    expect(controle(b, [])).toBeNull();
  });

  test("the command line: nieuw, lijst, lees, and usage", () => {
    const map = path.join(dir, "cli");
    const draai = (...a: string[]) => {
      const p = Bun.spawnSync(["bun", SCRIPT, ...a, "--map", map], { stdout: "pipe", stderr: "pipe", env: { ...process.env, LAB_LEAD_NAAM: "labbawuah-1c" } });
      return { code: p.exitCode, uit: p.stdout.toString(), fout: p.stderr.toString() };
    };
    expect(draai("nieuw", ...args).code).toBe(0);
    expect(JSON.parse(readFileSync(path.join(map, "hook-plek.json"), "utf8")).door).toBe("labbawuah-1c");
    expect(draai("lijst").uit).toContain("open      hook-plek");
    expect(JSON.parse(draai("lees", "hook-plek").uit).id).toBe("hook-plek");
    expect(draai("lees", "bestaat-niet").code).toBe(1);
    expect(draai("nieuw", ...args).code).toBe(1);
    expect(draai("onzin").code).toBe(2);
    // A choice written into the file without the passkey: lees and lijst say so.
    const pad = path.join(map, "hook-plek.json");
    writeFileSync(pad, JSON.stringify({ ...JSON.parse(readFileSync(pad, "utf8")), keuze: { optie: "ja", door: "iphone-1", tijd: "2026-10-06T11:00:00.000Z" } }));
    const audit = path.join(dir, "audit.jsonl");
    writeFileSync(audit, "");
    const l = draai("lees", "hook-plek", "--audit", audit);
    expect(JSON.parse(l.uit).controle).toBe("onbevestigd");
    expect(l.fout).toContain("onbevestigd");
    expect(draai("lijst", "--audit", audit).uit).toContain("ONBEVESTIGD hook-plek");
    writeFileSync(audit, `${JSON.stringify({ tijd: "2026-10-06T10:59:50.000Z", gebeurtenis: "passkey-actie", apparaat: "iphone-1", doel: "besluit:hook-plek", ok: true })}\n`);
    expect(JSON.parse(draai("lees", "hook-plek", "--audit", audit).uit).controle).toBe("bevestigd");
    expect(draai("lijst", "--audit", audit).uit).toContain("beslist   hook-plek  → ja");
  });
});
