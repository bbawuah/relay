// Hulp voor tests die `bun <script>` als kindproces draaien.
//
// Bun 1.4.2 crasht zelden bij het opstarten (macOS-crashrapport: SIGTRAP via de crash-handler,
// 0,2 s na de start, vóór er een regel van ons script draait). Bun.spawnSync geeft dan
// exitCode `null` en signalCode "SIGTRAP". Dat is geen fout in wachtrij.ts. Een kindproces dat
// door een crash-signaal stierf zonder één byte uitvoer heeft nog niets gedaan, dus één keer
// opnieuw starten is veilig. Andere signalen (SIGKILL, SIGTERM) en alles met uitvoer
// worden niet herhaald: dat zou een echte fout verbergen.

export const CRASH_SIGNALEN = ["SIGTRAP", "SIGSEGV", "SIGBUS", "SIGILL", "SIGABRT"] as const;

export type Resultaat = {
  exitCode: number | null;
  signalCode?: string | null;
  stdout: { length: number };
  stderr: { length: number };
};

export const isStartCrash = (r: Resultaat): boolean =>
  r.exitCode === null && !!r.signalCode && (CRASH_SIGNALEN as readonly string[]).includes(r.signalCode) && r.stdout.length === 0 && r.stderr.length === 0;

/** Draait `start`; bij een start-crash (zie boven) eenmaal opnieuw. `pogingen` telt de starts. */
export function metStartHerstel<R extends Resultaat>(start: () => R): { r: R; pogingen: number } {
  const eerste = start();
  if (!isStartCrash(eerste)) return { r: eerste, pogingen: 1 };
  return { r: start(), pogingen: 2 };
}

/** Tekst voor een assertie: waarom het kindproces geen exitcode heeft. */
export const stopReden = (r: Resultaat): string => (r.exitCode === null ? `kindproces gedood door signaal ${r.signalCode ?? "onbekend"}` : `exit ${r.exitCode}`);
