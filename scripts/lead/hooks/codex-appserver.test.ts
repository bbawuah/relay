import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAppServer } from "./codex-appserver";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-appserver-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Een nep-`codex`: een bun-script dat `app-server` spreekt (JSON per regel) en elk verzoek met CODEX_HOME in een logbestand zet. */
function nepCodex(gedrag: string): string {
  const pad = join(dir, "codex");
  writeFileSync(
    pad,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const log = process.env.NEP_LOG;
const gedrag = ${JSON.stringify(gedrag)};
if (process.argv[2] !== "app-server") process.exit(3);
const dec = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk);
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    appendFileSync(log, JSON.stringify({ home: process.env.CODEX_HOME, cwd: process.cwd(), ...m }) + "\\n");
    if (m.id === undefined) continue;
    if (gedrag === "stil") continue;
    if (m.method === "initialize") console.log(JSON.stringify({ id: m.id, result: { userAgent: "nep" } }));
    else if (m.method === "hooks/list" && gedrag === "fout") console.log(JSON.stringify({ id: m.id, error: { message: "geen toegang" } }));
    else if (m.method === "hooks/list") console.log("geen json op deze regel"), console.log(JSON.stringify({ id: m.id, result: { data: [{ hooks: [{ key: "k1", eventName: "stop", command: "c", currentHash: "sha256:aa", trustStatus: "untrusted" }] }, { hooks: [] }] } }));
    else if (m.method === "config/value/write") console.log(JSON.stringify({ id: m.id, result: {} }));
    else console.log(JSON.stringify({ id: m.id, error: { message: "onbekende methode" } }));
  }
}
`,
  );
  chmodSync(pad, 0o755);
  return pad;
}

const verzoeken = (): Array<Record<string, unknown>> =>
  readFileSync(join(dir, "log.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((r) => JSON.parse(r));

describe("startAppServer", () => {
  test("handshake, hooks/list met cwd, vertrouw als config/value/write op hooks.state; CODEX_HOME en cwd gaan mee", async () => {
    process.env.NEP_LOG = join(dir, "log.jsonl");
    try {
      const s = await startAppServer(nepCodex("normaal"), join(dir, "home"), dir, 5000);
      const hooks = await s.hooks("/een/map");
      expect(hooks).toEqual([{ key: "k1", eventName: "stop", command: "c", currentHash: "sha256:aa", trustStatus: "untrusted" }]);
      await s.vertrouw({ k1: "sha256:aa" });
      s.sluit();
      const v = verzoeken();
      expect(v.map((r) => r.method)).toEqual(["initialize", "initialized", "hooks/list", "config/value/write"]);
      expect(v[0]).toMatchObject({ home: join(dir, "home"), jsonrpc: "2.0", params: { clientInfo: { name: "lab-peerbus-installeer" } } });
      expect(v[2].params).toEqual({ cwds: ["/een/map"] });
      expect(v[3].params).toEqual({ keyPath: "hooks.state", value: { k1: { trusted_hash: "sha256:aa" } }, mergeStrategy: "upsert" });
    } finally {
      delete process.env.NEP_LOG;
    }
  });

  test("een fout van de server wordt een fout met de methode; geen antwoord binnen de tijdsgrens ook (en de server wordt gestopt)", async () => {
    process.env.NEP_LOG = join(dir, "log.jsonl");
    try {
      const s = await startAppServer(nepCodex("fout"), dir, dir, 5000);
      await expect(s.hooks(dir)).rejects.toThrow("codex app-server: hooks/list: geen toegang");
      s.sluit();
      await expect(startAppServer(nepCodex("stil"), dir, dir, 50)).rejects.toThrow(/geen antwoord op initialize/);
    } finally {
      delete process.env.NEP_LOG;
    }
  });
});
