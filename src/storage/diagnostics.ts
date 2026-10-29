/** Persist only these texts: host values, exceptions and endpoints are untrusted. */
export const DIAG = {
  failed: "Notification delivery failed.", deferred: "Notification deferred.",
  missing: "No notification adapter available.", unsupported: "Notification unsupported.",
  exhausted: "Notification attempts exhausted.", timeout: "Notification timed out.",
  invalid: "Invalid notification result.", superseded: "Notification endpoint superseded.",
} as const;
const allowed = new Set<unknown>(Object.values(DIAG));
export function safeDiagnosis(value: unknown): string {
  return allowed.has(value) ? value as string : DIAG.failed;
}
