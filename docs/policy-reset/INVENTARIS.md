# Legacy agentbeleid verwijderen

Basis: `003773bfda5b913e2698562cb9805c1a31720374`, branch `fix/remove-agent-policy`, appgebonden worktree `/Users/labbawuah/.t3/worktrees/relay/fix-remove-agent-policy`. De oorspronkelijke checkout `/Users/labbawuah/relay` blijft ongewijzigd. De bronreferentie voor retirement is uitsluitend gelezen op monorepocommit `364a58052692a6229c85baecdbc124c1e7e5bd15`; geselecteerde governancewijzigingen zijn hier toegepast, geen productboom geïmporteerd.

## Verwijderd

- `peers/bus.ts`: default hold voor niet-gerelateerde peers, expliciete `hold`/`refuse`, afwijkende inboundwaarden en regels per afzender. Oude metadata blijft leesbaar; nieuwe sends worden direct afgeleverd.
- `peers/cli.ts`: `eisBeheer` en het onderscheid tussen `lead`, `lead-proef` en andere rollen. Elke geregistreerde sessie kan haar eigen historische post inspecteren en expliciet herstellen. Een lokale operator zonder sessie-identiteit moet een ontvanger kiezen. Herstel vereist IDs of `--alle` en meldt aantallen.
- `hooks/hook.ts`, `hook.sh`: rapportplicht en Stop-blokkades voor rapportage of ongelezen post. De optionele wekker werkt voor ieder roletiket en leest alleen eigen meldingen.
- `hooks/grenzen.sh`: globale commandopolicy, rolvoorwaarden, verplichte paden voor push/merge, hoofdcheckoutverboden en productspecifieke guards. Alleen de 229-byte compatibiliteitsshim blijft. Productbeveiliging hoort bij het product en de native providerconfiguratie; Relay installeert geen globale vervanging.
- `hooks/codex-wrap.*`: vaste naam/rol op basis van `.codex-lead` en fail-closed gedrag voor ontbrekende optionele registratie. Private checkout-identiteit blijft boven de geërfde daemonomgeving gaan.
- `hooks/codex-controle.ts`: verplichte governancehook, trust-hashcontrole en websearchbeleid als startvoorwaarde. `codex-installeer.ts` genereert geen grenzenhook en schrijft geen native hooktrust.
- `leadnaam.ts`: parentaanwezigheid en naamambiguïteit worden onafhankelijk van rol gecontroleerd; `lead-proef` behoudt bestaande statusroutering zonder rolverhoging.
- `spawn.sh`, `lead-codex.sh`: verplichte actualiteitsfetch, policyhome, profiel, logincontrole, websearch-uit, upstreamconfiguratie, verboden op workerpush, verplichte rapportslotregels en vaste subleadworkflow. De optionele workflowhulp heeft geen verplichte Claude-modellen of productpad meer.
- `merge.sh`, `wachtrij.ts`, `push.sh`, `.githooks/pre-push`: rolprivileges, akkoordmarkers, lokale poortstempels, rolgebonden skip/stiltevenster en verplichte eigen hookinstallatie. `push-werker.*` met zijn privileged route en overgeslagen hooks is verwijderd.
- `beleid/*`: generatie en typen van commandoregels, rolprofielen en grenzenhooks. Bestaande lege legacyvelden blijven voor callers beschikbaar. De Claude-generator installeert uitsluitend optionele status- en bericht-events.
- `installeer-grens.ts`: installatie van mergepolicybestanden. De WebAuthn-runner en zijn installatiecontroles blijven behouden.

## Behouden

- Registratie, naamvalidatie, private bestandsrechten, spawn-ID-eigenaarschap, identiteitsverval, daemonisolatie en bestaande `lead-proef`-sessiebinding/lifecycle. Het label blijft compatibel en wordt niet naar `lead` verhoogd.
- Mailboxeigenaarschap, weigering van foreign ack en dubbelzinnige hoofdletteridentiteiten. Het nieuwe herstel kan andermans envelop niet naar de gekozen inbox verplaatsen.
- Berichtgrootte 16.000 tekens, 20 pogingen/minuut, maximaal 8 hops, wachtrijlimiet 50 inclusief historische heldpost, dedupe, locks, retentie en inhoudsloze weksignalen. Dit zijn betrouwbaarheidscontroles, geen rolbeleid.
- Anti-corruptie: atomaire herstelpublicatie, dedupe op opgeslagen IDs, behoud van geackte inboxbewijzen zolang een oude heldkopie bestaat, en behoud van vreemde/onleesbare historische regels. Installatie replayt of verwijdert geen heldpost.
- Native providerapprovals, native hooktrust, bestaande Git-hooks, gewone CI, headvergelijking en leases; geen bypassvlaggen of permissieverhoging toegevoegd.
- `git-hard`, preloadisolatie, veilige Bun-installatieargumenten, testisolatie, product-WebAuthn/passkeys/LaunchAgent en `lab-lees.sh` blijven intact. Geen vendor- of runtimeupgrade.

## Bekende grens en projectconfiguratie

Issue 718: `peers/server.ts` bepaalt de fallbackidentiteit nog eenmalig bij het starten. Deze patch wijzigt die cache niet, verzwakt de sessiescoping niet en claimt geen herstel van verkeerde inboxen vóór binding, na expiry of na SessionEnd. Historisch herstel blijft daarom expliciete CLI-bediening; geen nieuwe muterende MCP-tools op die cache.

`relay.toml` bevat hier alleen `project.default_branch` en `checks.full_gate`; er is in deze boom geen runtimecaller die inbound- of rolbeleid uit dat bestand leest. Projectspecifieke checks blijven projectconfiguratie. De remote `main` is een andere message-only productboom en is geen veilige mergebase voor deze launcherpatch.

## Branchrelatie

Remote `feat/relay-codex-default` stond bij aanvang op `30de13e46326c3edac957b00b6b373c3634fa16e`. Deze basis bevat daarboven drie lokale commits: `227eba9`, `9904db3`, `003773b`. Alleen de normale featurebranch wordt gepubliceerd. Root `64847d95-5062-48cb-9506-4d3c9e7f19c5` coördineert de ontbrekende basiscommits, integratie, merge en live activering. Geen push naar andermans branch en geen wholesale merge naar remote main.

Zie [activering](ACTIVERING.md), [testpensioen](../../scripts/lead/TESTPENSIOEN.md) en [fixturebewijs](evidence/README.md).
