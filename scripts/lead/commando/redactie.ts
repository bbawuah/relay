// Redactie van uitvoer voor kaart en lead: ANSI en stuurtekens eruit, bekende geheimvormen vervangen.
// Een vangnet: soorten met geheimen in de uitvoer horen niet in fase 1 (PLAN §3.6).

const GEHEIM = "[geredigeerd]";

const PATRONEN: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /-----BEGIN [A-Z ]*KEY-----[\s\S]*?(?:-----END [A-Z ]*KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\btskey-[A-Za-z0-9-]{10,}/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Za-z0-9_]*(?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi,
  /\b[0-9a-fA-F]{40,}\b/g,
  /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g,
];

// CSI/OSC-reeksen eerst, daarna de overige stuurtekens.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

// Stuurtekens (behalve \n en \t), soft hyphen, zero-width en bidi-tekens. Uit codepunten opgebouwd,
// zodat er geen rauwe onzichtbare tekens in de bron staan.
const STUUR_BEREIKEN: ReadonlyArray<readonly [number, number]> = [
  [0, 8], [11, 31], [127, 159], [173, 173], [8203, 8207], [8232, 8238], [8288, 8297], [65279, 65279],
];
const esc = (n: number): string => `\\u${n.toString(16).padStart(4, "0")}`;
/** Een regex-tekenklasse (als tekst) met alle verboden stuur- en bidi-tekens; ook voor het schema. */
export const STUUR_KLASSE = `[${STUUR_BEREIKEN.map(([a, b]) => esc(a) + (b > a ? `-${esc(b)}` : "")).join("")}]`;
const STUUR = new RegExp(STUUR_KLASSE, "g");

export function redigeer(tekst: string): string {
  let t = tekst.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(STUUR, "");
  for (const p of PATRONEN) t = t.replace(p, GEHEIM);
  return t;
}

const MAX_STAART_BYTES = 2048;

/** De laatste `regels` regels na redactie, samen hooguit 2 KB (van achteren af gehouden). */
export function staart(tekst: string, regels = 20): string[] {
  const r = redigeer(tekst).split("\n");
  while (r.length && r[r.length - 1] === "") r.pop();
  const uit: string[] = [];
  let bytes = 0;
  for (const regel of r.slice(-regels).reverse()) {
    let s = regel;
    while (Buffer.byteLength(s) + 1 > MAX_STAART_BYTES - bytes && s.length > 0) s = s.slice(0, -1);
    if (!s && regel) break;
    bytes += Buffer.byteLength(s) + 1;
    uit.unshift(s);
  }
  return uit;
}
