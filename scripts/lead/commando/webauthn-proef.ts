// Alleen voor tests: een nep-authenticator die WebAuthn-assertions maakt zoals een iPhone dat doet.
// Het sleutelpaar wordt hier gemaakt (crypto.subtle), nooit uit een bestand gelezen.

import { createHash } from "node:crypto";
import type { Akkoord } from "@lab-bawuah/lab-commando";
import type { Sleutels } from "./runner";

const b64 = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof ArrayBuffer ? new Uint8Array(b) : b).toString("base64url");
const sha = (b: Uint8Array | string) => new Uint8Array(createHash("sha256").update(b).digest());

/** COSE EC2-sleutel (P-256, ES256) in CBOR: {1:2, 3:-7, -1:1, -2:x, -3:y}. */
function cose(x: Uint8Array, y: Uint8Array): Uint8Array {
  return new Uint8Array([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20, ...x, 0x22, 0x58, 0x20, ...y]);
}

/** Ruwe r||s (64 bytes) naar ASN.1 DER, zoals WebAuthn de handtekening levert. */
function der(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = b.subarray(i);
    return v[0]! & 0x80 ? [0x02, v.length + 1, 0, ...v] : [0x02, v.length, ...v];
  };
  const r = int(raw.subarray(0, 32));
  const s = int(raw.subarray(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

export interface Authenticator {
  credentialId: string;
  publicKey: string;
  /** Maakt een assertion; de opties maken elke afwijking uit PLAN §6 na. */
  teken(o: { challenge: string; origin: string; rpID: string; uv?: boolean; up?: boolean; type?: string }): Promise<Akkoord["assertion"]>;
}

export async function maakAuthenticator(): Promise<Authenticator> {
  const paar = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", paar.publicKey);
  const x = new Uint8Array(Buffer.from(jwk.x!, "base64url"));
  const y = new Uint8Array(Buffer.from(jwk.y!, "base64url"));
  const credentialId = b64(crypto.getRandomValues(new Uint8Array(16)));
  return {
    credentialId,
    publicKey: b64(cose(x, y)),
    async teken({ challenge, origin, rpID, uv = true, up = true, type = "webauthn.get" }) {
      const vlaggen = (up ? 0x01 : 0) | (uv ? 0x04 : 0);
      const authData = new Uint8Array([...sha(rpID), vlaggen, 0, 0, 0, 1]);
      const clientData = new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
      const data = new Uint8Array([...authData, ...sha(clientData)]);
      const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, paar.privateKey, data));
      return { credentialId, authenticatorData: b64(authData), clientDataJSON: b64(clientData), signature: b64(der(raw)) };
    },
  };
}

export function sleutelsVoor(a: Authenticator[], rpID = "localhost", origins = ["http://localhost:8399"]): Sleutels {
  return { versie: 1, rpID, origins, sleutels: a.map((x) => ({ credentialId: x.credentialId, publicKey: x.publicKey })) };
}
