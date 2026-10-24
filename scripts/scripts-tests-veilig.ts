// De allowlist van de poortstap scripts-tests: paden waarvan een wijziging nooit een scripts-test kan breken.
// Omgekeerd ontwerp (24 okt, besluit lead): de stap wordt alleen overgeslagen als ELK gewijzigd bestand (nieuw,
// gewijzigd, verwijderd, oud pad van een rename) onder SCRIPTS_TESTS_VEILIG valt en niet onder een uitzondering.
// Al het andere draait. Een onbekend pad betekent dus draaien; een vergeten pad kost alleen tijd, geen groene
// poort die niets bewijst. De bewaker scripts-tests-paden.test.ts toetst dat geen scripts-test een pad hieronder noemt.
// Dit bestand wordt door de bewaker niet gescand (het noemt de paden per definitie).

/** Mappen (met slot-/) waarvan geen scripts-test iets leest. Elk pad moet in de repo bestaan (bewaker). */
export const SCRIPTS_TESTS_VEILIG: readonly string[] = [
  "apps/goldcoast-klant/",
  "apps/goldcoast-operatie/",
  "packages/goldcoast-contracts/",
  "apps/site/",
  // packages/goldcoast-query/ komt erbij zodra het package in main staat (de bewaker eist dat het pad bestaat).
];

/** Paden onder een veilige map die tóch gelezen worden. */
export const SCRIPTS_TESTS_VEILIG_UITZONDERING: readonly { patroon: RegExp; reden: string }[] = [
  { patroon: /^apps\/site\/scripts(\/|$)/, reden: "vercel-ignore.test.ts kopieert apps/site/scripts/vercel-ignore.sh" },
  { patroon: /^(apps|packages)\/[^/]+\/turbo\.jsonc?$/, reden: "turbo-inputs.test.ts scant elke workspace-turbo.json(c)" },
];

/** Is dit gewijzigde bestand (of deze map) veilig om geen scripts-tests voor te draaien? */
export function isVeilig(pad: string): boolean {
  const p = pad.replace(/\/+$/, "");
  if (SCRIPTS_TESTS_VEILIG_UITZONDERING.some((u) => u.patroon.test(p))) return false;
  return SCRIPTS_TESTS_VEILIG.some((v) => `${p}/`.startsWith(v));
}
