// Historische opslagfixtures voor tests; aanroepers bezitten hun tijdelijke staatmap.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { geldigeNaam } from "./bus";
import type { Envelop } from "./types";
import { uuidv7 } from "./uuid";

export function oudePost(staat: string, naar: string, tekst: string, extra: Partial<Envelop> = {}): Envelop {
  if (!geldigeNaam(naar)) throw new Error("ongeldige fixtureontvanger");
  const e: Envelop = { id: uuidv7(), van: "a", naar, draad: uuidv7(), ts: new Date().toISOString(), hop: 1, herkomst: "schoon", soort: "bericht", tekst, ...extra };
  const map = join(staat, "peers/vastgehouden");
  mkdirSync(map, { recursive: true, mode: 0o700 });
  appendFileSync(join(map, `${naar.toLowerCase()}.jsonl`), `${JSON.stringify(e)}\n`, { mode: 0o600 });
  return e;
}
