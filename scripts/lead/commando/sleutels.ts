/** Onafhankelijke validatie van de publieke passkeybundel voor de installer. */
export interface Sleutel { credentialId: string; publicKey: string; apparaat?: string }
export interface Sleutels { versie: 1; rpID: string; origins: string[]; sleutels: Sleutel[] }

const B64URL = /^[A-Za-z0-9_-]+$/;
const exact = (x: unknown, sleutels: string[], optioneel: string[], wat: string): Record<string, unknown> => {
  if (!x || typeof x !== "object" || Array.isArray(x)) throw new Error(`${wat}: geen object`);
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!sleutels.includes(k) && !optioneel.includes(k)) throw new Error(`${wat}: onbekende sleutel ${k}`);
  for (const k of sleutels) if (!(k in o)) throw new Error(`${wat}: ${k} ontbreekt`);
  return o;
};
const tekst = (o: Record<string, unknown>, k: string, re: RegExp, wat: string, max = 4096): string => {
  const v = o[k];
  if (typeof v !== "string" || v.length > max || !re.test(v)) throw new Error(`${wat}: ${k} ongeldig`);
  return v;
};

export function valideerSleutels(x: unknown): Sleutels {
  const o = exact(x, ["versie", "rpID", "origins", "sleutels"], [], "passkeys.pub");
  if (o.versie !== 1) throw new Error("passkeys.pub: versie is geen 1");
  const rpID = tekst(o, "rpID", /^[a-z0-9.-]{1,253}$/, "passkeys.pub");
  if (!Array.isArray(o.origins) || o.origins.length === 0 || o.origins.length > 8) throw new Error("passkeys.pub: origins ongeldig");
  const origins = o.origins.map((v) => {
    if (typeof v !== "string" || !/^(https:\/\/[a-z0-9.-]+|http:\/\/localhost)(:\d{1,5})?$/.test(v)) throw new Error(`passkeys.pub: origin ${String(v)} ongeldig`);
    return v;
  });
  if (!Array.isArray(o.sleutels) || o.sleutels.length === 0 || o.sleutels.length > 20) throw new Error("passkeys.pub: sleutels ongeldig");
  const sleutels = o.sleutels.map((s) => {
    const k = exact(s, ["credentialId", "publicKey"], ["apparaat"], "sleutel");
    return { credentialId: tekst(k, "credentialId", B64URL, "sleutel", 1024), publicKey: tekst(k, "publicKey", B64URL, "sleutel", 1024), ...(k.apparaat === undefined ? {} : { apparaat: tekst(k, "apparaat", /^[\x20-\x7e]{1,64}$/, "sleutel") }) };
  });
  return { versie: 1, rpID, origins, sleutels };
}
