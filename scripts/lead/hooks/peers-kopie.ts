// Wat de installers (installeer-hooks.ts en hooks/codex-installeer.ts) naast de hookbestanden kopiëren zodat hook.ts de peerbus
// kan laden in de platte geïnstalleerde map: de bus (peers/) en een tweede register.ts onder hooks/ (bus.ts importeert ../hooks/register).
// In de repo ligt hook.ts naast ../peers; geïnstalleerd ligt de bus op <doel>/peers (zie laadPeers in hook.ts).

import { join } from "node:path";

export const PEERS_BESTANDEN = ["bus.ts", "standaard.ts", "types.ts", "uuid.ts"];

/** [bron, doel]-paren; `bron` is de map met hook.ts (scripts/lead/hooks), `doel` de installatiemap. */
export function peersKopieen(bron: string, doel: string): [string, string][] {
  return [
    ...PEERS_BESTANDEN.map((b): [string, string] => [join(bron, "..", "peers", b), join(doel, "peers", b)]),
    [join(bron, "register.ts"), join(doel, "hooks", "register.ts")],
  ];
}
