// uuidv7 (RFC 9562): 48 bit tijd in ms, versie 7, 12 bit teller, 62 bit willekeur. Geen dependency.
// Binnen één proces is de uitvoer strikt stijgend, ook binnen dezelfde milliseconde en als de klok terugloopt.

let laatsteMs = 0;
let teller = 0;

export function uuidv7(nu: number = Date.now()): string {
  const r = crypto.getRandomValues(new Uint8Array(10));
  let ms = Math.max(nu, laatsteMs);
  if (ms === laatsteMs) {
    teller += 1;
    if (teller > 0xfff) {
      ms += 1;
      teller = r[0]! & 0x0f;
    }
  } else {
    teller = ((r[0]! << 8) | r[1]!) & 0x7ff; // ruimte om op te tellen
  }
  laatsteMs = ms;
  const b = new Uint8Array(16);
  const tijd = BigInt(ms);
  for (let i = 0; i < 6; i++) b[i] = Number((tijd >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = 0x70 | (teller >> 8);
  b[7] = teller & 0xff;
  b[8] = 0x80 | (r[2]! & 0x3f);
  b.set(r.subarray(3, 10), 9);
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
