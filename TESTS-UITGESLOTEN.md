# Uitgesloten tests

Deze bestanden hoorden bij de gefilterde LAB-BAWUAH-productrepository. Ze
testen geen zelfstandige relay-functionaliteit en zijn daarom niet onderdeel
van `bun test` in deze repository. De bron blijft bewaard onder
`tests-uitgesloten/` als herkomstnotitie.

| Oorspronkelijk bestand | Reden |
| --- | --- |
| `scripts/lab.test.ts` | Test de LAB-BAWUAH CLI (`scripts/lab.ts`), die geen onderdeel van relay is. |
| `scripts/poort.test.ts` | Test de productpoort en de bijbehorende productchecks (`e2e-slot`, databases, apps en pakketten) die niet naar relay zijn overgenomen. |
| `scripts/scripts-tests-paden.test.ts` | Dwingt een LAB-BAWUAH-allowlist voor productmappen en -pakketten af. |
| `scripts/lead/besluit.test.ts` | Test besluiten uit `apps/tmux/server/besluiten`, een uitgesloten productmodule. |
| `scripts/lead/vraag-brian.test.ts` | Test de productpackage `@lab-bawuah/lab-commando`; relay bevat alleen de generieke peer- en hooklaag. |
| `scripts/lead/commando-gelijk.test.ts` | Vergelijkt relay-code met `@lab-bawuah/lab-commando` en de producttijdvenster-helper. |
| `scripts/lead/commando/runner.test.ts` | Test de productgebonden, WebAuthn-geautoriseerde commandorunner met `@lab-bawuah/lab-commando`. |

Een test wordt alleen hier opgenomen als hij een ontbrekende productmodule of
productpackage als onderwerp heeft. Relay-tests voor beleid, hooks, peers en
generieke leadlogica blijven in de gewone suite.
