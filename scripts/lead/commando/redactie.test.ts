import { describe, expect, test } from "bun:test";
import { redigeer, staart } from "./redactie";

const G = "[geredigeerd]";
// Fixtures worden uit stukken samengesteld, zodat er geen echt uitziende sleutel in de bron staat.
const fixtures: Array<[string, string]> = [
  ["GitHub-token", `token van ${"gh" + "p_"}${"a1".repeat(15)} klaar`],
  ["GitHub fine-grained", `${"github" + "_pat_"}${"A1b2".repeat(8)}`],
  ["tailscale-sleutel", `${"ts" + "key-"}auth-${"k".repeat(20)}`],
  ["Slack", `${"xo" + "xb-"}123456789012-${"a".repeat(12)}`],
  ["AWS", `${"AK" + "IA"}${"ABCDEFGH".repeat(2)}`],
  ["privésleutel", `${"-----BEGIN "}OPENSSH PRIVATE KEY-----\nabc\ndef\n${"-----END "}OPENSSH PRIVATE KEY-----`],
  ["Bearer", `Authorization: ${"Bear" + "er"} abcdef123456.xyz`],
  ["JWT", `${"ey" + "J"}hbGciOiJIUzI1NiJ9.${"eyJzdWIiOiIx"}.${"c2lnbmF0dXJl"}`],
  ["password=", "password=hunter22"],
  ["TOKEN: ", "API_TOKEN: waarde123"],
  ["hex van 64", "a".repeat(32) + "0123456789abcdef0123456789abcdef"],
  ["base64 van 44", `${"Qk".repeat(22)}`],
];

describe("redigeer", () => {
  for (const [naam, invoer] of fixtures) {
    test(`vervangt ${naam}`, () => {
      const uit = redigeer(`voor ${invoer} na`);
      expect(uit).toContain(G);
      expect(uit).toContain("voor");
    });
  }

  test("laat gewone uitvoer ongemoeid", () => {
    const t = "To github.com:bbawuah/LAB-BAWUAH.git\n - [deleted]         lead/x\nHTTP 200 ok, abc123";
    expect(redigeer(t)).toBe(t);
  });

  test("haalt ANSI-reeksen weg", () => {
    expect(redigeer(`${String.fromCharCode(27)}[31mrood${String.fromCharCode(27)}[0m en ${String.fromCharCode(27)}]0;titel${String.fromCharCode(7)}klaar`)).toBe("rood en klaar");
  });

  test("haalt stuur-, bidi- en zero-width-tekens weg, houdt \\n en \\t", () => {
    const slecht = [0, 7, 127, 0x202e, 0x200b, 0xfeff, 0x2066, 0x061c, 0x180e].map((c) => String.fromCodePoint(c)).join("");
    expect(redigeer(`a${slecht}b\n\tc`)).toBe("ab\n\tc");
  });

  test("CRLF wordt LF", () => {
    expect(redigeer("a\r\nb\rc")).toBe("a\nb\nc");
  });
});

describe("staart", () => {
  test("geeft standaard de laatste 20 regels", () => {
    const t = Array.from({ length: 50 }, (_, i) => `regel ${i + 1}`).join("\n");
    const s = staart(t);
    expect(s).toHaveLength(20);
    expect(s[0]).toBe("regel 31");
    expect(s.at(-1)).toBe("regel 50");
  });

  test("negeert afsluitende lege regels en kent een eigen aantal", () => {
    expect(staart("a\nb\nc\n\n\n", 2)).toEqual(["b", "c"]);
    expect(staart("")).toEqual([]);
  });

  test("redigeert eerst", () => {
    expect(staart("x\npassword=geheim")).toEqual(["x", G]);
  });

  test("blijft onder 2 KB en houdt het einde", () => {
    const regels = Array.from({ length: 20 }, (_, i) => `${i}`.padStart(2, "0") + " " + "woord ".repeat(50));
    const s = staart(regels.join("\n"));
    expect(Buffer.byteLength(s.join("\n"))).toBeLessThanOrEqual(2048);
    expect(s.at(-1)!.startsWith("19 ")).toBe(true);
  });
});
