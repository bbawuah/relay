import { describe, expect, test } from "bun:test";
import { afgeleid, type Ctx, type Verzoek } from "./schema";
import { herken, LIVE_POORTEN, soort, soorten, stilteReden, stilteVoor } from "./soorten";

const ctx: Ctx = { kloon: "/kloon", test: true };
const live: Ctx = { kloon: "/kloon", test: false };

/** Of een soort deze params toelaat: regex én extraCheck, zoals `afgeleid` ze toetst. */
function toegelaten(id: string, params: Record<string, string>): boolean {
  const v: Verzoek = { versie: 1, id: "t-123", soort: id, params, waarom: "x", door: "d", lead: "l", tijd: "2026-10-21T10:00:00Z", verlooptS: 9_999_999_999 };
  try {
    afgeleid(v, ctx);
    return true;
  } catch {
    return false;
  }
}

describe("soorten", () => {
  test("fase 1: tak-weg, tailnet-open, tailnet-dicht; proef-echo alleen in teststand", () => {
    expect(soorten(live).map((s) => s.id)).toEqual(["tak-weg", "tailnet-open", "tailnet-dicht"]);
    expect(soorten(ctx).map((s) => s.id)).toEqual(["tak-weg", "tailnet-open", "tailnet-dicht", "proef-echo"]);
    expect(soort("proef-echo", live)).toBeUndefined();
    expect(soort("proef-echo", ctx)?.alleenTest).toBe(true);
  });

  test("niets in fase 1 is zwaar", () => {
    expect(soorten(ctx).some((s) => s.zwaar)).toBe(false);
  });

  test("LIVE_POORTEN is de lijst uit het contract", () => {
    expect([...LIVE_POORTEN]).toEqual([8220, 8230, 8232, 8260, 8448, 8449]);
  });

  test("elke soort heeft een vaste PATH en nooit een shell in argv", () => {
    for (const s of soorten(ctx)) {
      expect(s.env(ctx).PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin");
      expect(Object.keys(s.env(ctx)).sort()).toEqual(["HOME", "LANG", "PATH"]);
    }
    expect(soort("tak-weg", ctx)!.argv({ tak: "lead/x" })[0]).toBe("bash");
  });
});

describe("tak-weg", () => {
  test("goede takken", () => {
    for (const tak of ["lead/x", "gc/db-luisterurl-export", "tmux/commando-kaart", "fix/a.b_c", "lead/commando-kern"]) expect(toegelaten("tak-weg", { tak })).toBe(true);
  });

  test("kwade takken", () => {
    const slecht = ["main", "master", "origin/main", "-f", "--force", "+x", "a b", "$(id)", "a;b", "x`y`", "../x", "a//b", "a..b", "x.lock", "x/", "/x", ".x", "a:b", "a*", "a?", "a[b", "a^b", "a~b", "a\\b", "é", "lead/ünicode", "", "a".repeat(101), "x@{y}"];
    for (const tak of slecht) expect([tak, toegelaten("tak-weg", { tak })]).toEqual([tak, false]);
  });

  test("param ontbreekt of is extra", () => {
    expect(toegelaten("tak-weg", {})).toBe(false);
    expect(toegelaten("tak-weg", { tak: "lead/x", extra: "1" })).toBe(false);
  });

  test("argv, cwd en wat", () => {
    const s = soort("tak-weg", ctx)!;
    expect(s.argv({ tak: "lead/x" })).toEqual(["bash", "scripts/lead/push.sh", "--verwijder", "lead/x"]);
    expect(s.cwd({ tak: "lead/x" }, ctx)).toBe("/kloon");
    expect(s.wat({ tak: "lead/x" })).toContain("lead/x");
  });
});

describe("tailnet", () => {
  test("open: https in 8440–8459 en geen live of bezette poort, app geen live poort", () => {
    expect(toegelaten("tailnet-open", { https: "8450", app: "5173" })).toBe(true);
    expect(toegelaten("tailnet-open", { https: "8459", app: "3000" })).toBe(true);
    for (const https of ["443", "80", "8439", "8460", "8448", "8449", "8443", "8446", "8447", "6006", "0450", "abc", "8450 ", "-1"]) expect([https, toegelaten("tailnet-open", { https, app: "5173" })]).toEqual([https, false]);
    for (const app of ["8220", "8230", "8232", "8260", "8448", "8449", "80", "1023", "70000", "x", "5173; ls"]) expect([app, toegelaten("tailnet-open", { https: "8450", app })]).toEqual([app, false]);
    expect(toegelaten("tailnet-open", { https: "8450" })).toBe(false);
  });

  test("dicht: dezelfde https-regels", () => {
    expect(toegelaten("tailnet-dicht", { https: "8450" })).toBe(true);
    for (const https of ["443", "8447", "8448", "8460", "x", ""]) expect(toegelaten("tailnet-dicht", { https })).toBe(false);
  });

  test("argv is serve, nooit funnel, met het volle pad", () => {
    const o = soort("tailnet-open", ctx)!.argv({ https: "8450", app: "5173" });
    expect(o).toEqual(["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "serve", "--bg", "--https=8450", "http://127.0.0.1:5173"]);
    const d = soort("tailnet-dicht", ctx)!.argv({ https: "8450" });
    expect(d).toEqual(["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "serve", "--https=8450", "off"]);
    expect(JSON.stringify(soorten(ctx).map((s) => s.argv(Object.fromEntries(Object.keys(s.params).map((k) => [k, "8450"])))))).not.toContain("funnel");
  });
});

describe("proef-echo", () => {
  test("alleen letters, cijfers en spaties", () => {
    expect(toegelaten("proef-echo", { tekst: "hallo wereld 1" })).toBe(true);
    for (const tekst of ["", "a;b", "$(id)", "a".repeat(41), "é"]) expect(toegelaten("proef-echo", { tekst })).toBe(false);
  });

  test("in de livestand bestaat de soort niet", () => {
    const v: Verzoek = { versie: 1, id: "t-123", soort: "proef-echo", params: { tekst: "hoi" }, waarom: "x", door: "d", lead: "l", tijd: "2026-10-21T10:00:00Z", verlooptS: 9_999_999_999 };
    expect(() => afgeleid(v, live)).toThrow("onbekende soort");
  });
});

describe("herken", () => {
  test("herkent elke soort uit zijn eigen argv", () => {
    const gevallen: Array<[string, Record<string, string>]> = [
      ["tak-weg", { tak: "lead/x" }],
      ["tailnet-open", { https: "8450", app: "5173" }],
      ["tailnet-dicht", { https: "8450" }],
      ["proef-echo", { tekst: "hoi" }],
    ];
    for (const [id, params] of gevallen) expect(herken(soort(id, ctx)!.argv(params), ctx)).toEqual({ soort: id, params });
  });

  test("herkent niets vreemds of net afwijkends", () => {
    expect(herken(["bash", "scripts/lead/push.sh", "--verwijder", "main"], ctx)).toBeNull();
    expect(herken(["bash", "scripts/lead/push.sh", "--verwijder", "lead/x", "--force"], ctx)).toBeNull();
    expect(herken(["bash", "scripts/lead/push.sh", "--delete", "lead/x"], ctx)).toBeNull();
    expect(herken(["sh", "-c", "git push origin :lead/x"], ctx)).toBeNull();
    expect(herken(["rm", "-rf", "/"], ctx)).toBeNull();
    expect(herken([], ctx)).toBeNull();
    expect(herken(["/bin/echo", "hoi"], live)).toBeNull();
  });
});

describe("stiltevenster", () => {
  const takWeg = soort("tak-weg", ctx)!;
  const zwaar = { ...takWeg, zwaar: true };
  const tijd = (s: typeof takWeg, t: string) => stilteReden(s, ctx, new Date(`2026-10-21T${t}:00+02:00`));

  test("een niet-zware soort heeft nooit een reden", () => {
    for (const t of ["04:59", "05:00", "06:00", "07:14", "07:15"]) expect(tijd(takWeg, t)).toBeNull();
  });

  test("een zware soort mag niet van 05:00 tot 07:15 (Amsterdam)", () => {
    expect(tijd(zwaar, "04:59")).toBeNull();
    expect(tijd(zwaar, "05:00")).toContain("stiltevenster");
    expect(tijd(zwaar, "07:14")).toContain("stiltevenster");
    expect(tijd(zwaar, "07:15")).toBeNull();
  });

  test("een soort die niet in de allowlist staat geeft een reden, nooit null", () => {
    expect(tijd({ ...takWeg, id: "bestaat-niet" }, "12:00")).toContain("onbekende soort");
    expect(stilteReden(soort("proef-echo", ctx)!, live)).toContain("onbekende soort");
  });

  test("stilteVoor op soort-id: onbekend geeft een reden", () => {
    expect(stilteVoor("bestaat-niet", ctx)).toContain("onbekende soort");
    expect(stilteVoor("tak-weg", ctx, new Date("2026-10-21T06:00:00+02:00"))).toBeNull();
  });
});

