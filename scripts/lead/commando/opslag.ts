// Opslag van de commando-knop: verzoeken, akkoorden, uitslagen en uitvoer als gewone bestanden.
// Map: ${LAB_COMMANDO:-~/.local/state/lab-commando} (700; bestanden 600). Schrijven is atomair
// (tmp + rename); lezen weigert symlinks, ook op de map, en te grote bestanden.
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const commandoMap = (): string => process.env.LAB_COMMANDO || join(homedir(), ".local/state/lab-commando");

/** Eigen clone van de runner op origin/main; server en runner bouwen er Ctx.kloon mee, zodat hun hash gelijk is. */
export const kloonPad = (): string => process.env.LAB_COMMANDO_KLOON || join(homedir(), "Library/Application Support/lab-b/commando/bron");

export const MAPPEN = { verzoeken: "verzoeken", akkoord: "akkoord", uitslag: "uitslag", uitvoer: "uitvoer", gebruikt: "gebruikt" } as const;

export interface Akkoord {
  versie: 1;
  id: string;
  hash: string;
  nonce: string;
  verlooptS: number;
  apparaat: string;
  tijd: string;
  assertion: { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string; userHandle?: string };
}

export type Stand = "open" | "geweigerd" | "bezig" | "klaar" | "fout" | "verlopen";

export interface Uitslag {
  versie: 1;
  id: string;
  stand: Exclude<Stand, "open">;
  exit?: number;
  staart: string[];
  reden?: string;
  tijd: string;
}

export function zorgVoorMappen(basis: string = commandoMap()): void {
  // mkdir laat een bestaande map ongemoeid; chmod zet hem alsnog op 700
  for (const d of [basis, ...Object.values(MAPPEN).map((m) => join(basis, m))]) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
}

export function schrijfAtomair(pad: string, inhoud: string): void {
  mkdirSync(dirname(pad), { recursive: true, mode: 0o700 });
  const tmp = `${pad}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(tmp, inhoud, { mode: 0o600, flag: "wx" });
  renameSync(tmp, pad);
}

/** Leest een gewoon bestand: geen symlink op het bestand of de map, hooguit `max` bytes. Gooit anders. */
export function leesGewoonBestand(pad: string, max = 64 * 1024): string {
  // de map van het bestand én de basismap erboven (<basis>/<soortmap>/<bestand>) mogen geen symlink zijn
  for (const d of [dirname(pad), dirname(dirname(pad))]) if (lstatSync(d).isSymbolicLink()) throw new Error(`map is een symlink: ${d}`);
  const l = lstatSync(pad);
  if (l.isSymbolicLink()) throw new Error(`bestand is een symlink: ${pad}`);
  if (!l.isFile()) throw new Error(`geen gewoon bestand: ${pad}`);
  const fd = openSync(pad, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); // NONBLOCK: een FIFO laat de open niet hangen
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`geen gewoon bestand: ${pad}`);
    if (st.size > max) throw new Error(`bestand te groot (${st.size} > ${max} bytes): ${pad}`);
    const buf = Buffer.alloc(st.size);
    let n = 0;
    while (n < st.size) {
      const r = readSync(fd, buf, n, st.size - n, n);
      if (r === 0) break;
      n += r;
    }
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
