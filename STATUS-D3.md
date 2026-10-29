# D3 — overdracht voor integratie en R4

Werkpad: `/Users/labbawuah/.t3/worktrees/relay/fix-vendor-eigendom`.
Tak: `fix/vendor-eigendom`. Basis: `b7200992f6cafaa096e6fa515aa06f4d7823db02`.
Alleen eigen D3-bestanden gewijzigd. F niet overgenomen; exports en het
lease-schema voor het aparte CLI-spoor zijn behouden. Commit-SHA volgt in de
terminaloverdracht, omdat dit bestand onderdeel van die commit is.

## F1 — gereproduceerd en gericht hersteld

De nieuwe regressie faalde op de basis: alleen de Relay-launcher werd met
SIGKILL gedood, de fake Codex leefde aantoonbaar, en worker2 kreeg exit 23 in
dezelfde checkout terwijl de test weigering verwachtte. De vendor werd vóór
deze tweede launch dus niet gedood.

Launch start nu een vertrouwde `src/session-child.ts` met de veilige bunArgs.
De bootstrap controleert onder dezelfde reserveringslock de exacte bestaande
lease, inclusief parent-PID en OS-starttijd. Voor Codex controleert hij ook de
bestaande identiteit. Hij bindt beide aan zichzelf vóór execve; ontbrekende of
gewijzigde claims stoppen vóór vendorcode. De lease bevat geen prompt of argv.
De parent verwijdert na bewezen child-exit alleen de bijbehorende identiteit.

Echte execve-proef op Bun 1.4.2: PID en OS-starttijd bleven identiek vóór/na
execve, stdin kwam door en exitcode 23 bleef behouden. De launcher-SIGKILL-test
is nu groen: drie pogingen met worker2/worker1/worker2 blijven geweigerd zolang
de vendor leeft; identiteit blijft worker1. Pas na echte vendordood start
worker2. Beide handoff-volgordes zijn getest met een vertraagde bootstrap:
herclaimer eerst => oude vendor start niet; bootstrap eerst => worker1 blijft
eigenaar en nieuwe launches blijven geblokkeerd. Ontbrekende/gewijzigde lease
en identiteit stoppen de echte helper vóór vendor of hostile-cwd-preload.
Geërfde stdin, exitcode, SIGHUP/SIGINT/SIGTERM en bestaande stale/legacy/races
zijn gericht gecontroleerd. Geen echte vendor of PTY-interactie uitgevoerd.

## F2 — gereproduceerd en gericht hersteld

De nieuwe verwerk()-regressies zijn ook met de oorspronkelijke register.ts en
hook.ts van b720099 uitgevoerd: 4 failures vóór kernwerk bij onbekende DB of
symlink-parent. Daarna zijn de gewijzigde bestanden teruggezet.

Zonder relevante identiteit of bij een andere spawn vindt geen DB-onderhoud
plaats. Matching legacy-identiteiten behouden refresh en cleanup zonder
SQLite te openen of een DB aan te maken. Een gedeelde filesystem-identiteitslock
publiceert atomair een niet-lege lock met PID/starttijd-token; opruiming van een
dode eigenaar verwijdert alleen diens token en nooit recursief een opvolgerlock.
Ook managed mutaties en lead-proefbinding gebruiken die lock. Alle onderhoud
herleest de actuele identiteit vóór mutatie; managed onderhoud houdt daarnaast
de DB-lock. Optioneel onderhoud wacht niet op bezette DB-/identiteitslocks en
heeft geen onbeschermde fallbackwrite. De publieke withLaunchLock-interface
behoudt zijn normale timeout.

Kernhookevents vangen uitsluitend fouten uit dit optionele onderhoud lokaal af.
SessionEnd meldt state/idle vóór onderhoud. Fouten gaan naar stderr en de eerste
fout per spawn krijgt waar het pad veilig is een privaat, exclusief aangemaakt
`identiteit/maintenance-<hash>.error`-bestand: hook.sh verbergt exit-0-stderr.
Er wordt niets overschreven; onveilige paden krijgen geen fallback-logwrite.

Bewijs via echte verwerk()-events: UserPromptSubmit wordt bezig, Stop geeft het
ongelezen-seintje, SessionEnd wordt weg en levert idle aan de abonnee. Gevallen:
absent/irrelevante identiteit, geweigerd managed onderhoud, symlink-parent,
matching legacy-identiteit met afwezige/onbekende DB en een werkelijk bezette
managed DB. Die laatste eventreeks bleef onder 500 ms. Onbekende DB-bytes en
geweigerde managed-identiteiten blijven intact. Legacy-opvolgers, dode locks en
bestaande lead-proefchecks zijn groen.

## F4 — gericht hersteld

Launch verifieert de gekozen PATH-Bun met een begrensde versiecheck vanuit de
vertrouwde runtime-root, met veilige startvlaggen en lege runtimeopties.
Minimaal 1.4.2 is vereist; de draaiende Bun is de geverifieerde fallback.
MCP, bootstrap en gegenereerde Claude-hooks gebruiken dezelfde gekozen Bun.
Argumentopbouw blijft apart testbaar. Beide MCP-envs zetten BUN_OPTIONS en
NODE_OPTIONS expliciet leeg, zodat een daemon die niet kan herintroduceren.
Een echte outer-MCP-proef met host-preloadopties gaf geen preloadmarker en
uitsluitend geldig JSON-RPC. PATH-Bun 1.3.0 => veilige fallback; 1.4.2 => gekozen
pad, gedeeld door hooks en MCP. Geen Bun-update of globale installatie.

## F3 — onderzocht, niet bewezen en niet gewijzigd

Een begrensde eigen fixture maakte 150 lease-rijen met circa 6 KB payload,
startte een PERSIST-transactie met cache_size=3, verwijderde en verving de rijen
met circa 10 KB payload en doodde de schrijver vóór COMMIT. De journal was
936224 bytes; de eerste 8 bytes waren nul. De ruwe DB gaf quick_check=ok;
een afzonderlijke DB+journal-kopie gaf quick_check=ok en de oorspronkelijke
150 x-rijen terug. withLaunchLock op de oorspronkelijke fixture heropende
eveneens met 150 rijen. Alle eigen F3-fixturebestanden zijn opgeruimd.

Dit is geen bewezen geldig hot-journal met beschadigde ruwe DB en geen kill
tijdens de page-writes van COMMIT. F3 blijft dus open/onbewezen; er is geen
recoveryfix of versoepeling van buitenlandse/symlink-guards gedaan. Als het
reviewscenario optreedt, kan launch/managed onderhoud fail-closed blijven tot
veilige recovery/interventie. Door F2 blijven de kernhookevents daarvan los.

## Definitieve gerichte verificatie

- `bun test tests/launch-safety.test.ts tests/session-survival.test.ts scripts/lead/hooks/hook-bus.test.ts scripts/lead/hooks/codex-wrap.test.ts tests/mcp-identity.test.ts`: 104 pass, 0 fail, 677 assertions, 7.60 s.
- `bun test tests/runtime-safety.test.ts -t 'bunArgs|cwd tsconfig'`: 3 pass, 0 fail, 11 assertions, 74 ms.
- `bun run typecheck`: groen. `git diff --check`: groen.
- Bun 1.4.2. Eigen devdeps frozen/ignore-scripts geïnstalleerd met tijdelijke HOME/cache.
- Geen volledige poort, build, e2e, subagents, live state/sockets, secrets, andere worktreewrites, push of merge. Gewone lokale commit met alle hooks actief.

De eerdere -g-toolweigering is vóór hervatting gemeld; na expliciete
herautorisatie uitsluitend de voorgeschreven --glob-volgorde gebruikt.
Geen verdere guardweigering tijdens de hervatte uitvoering. Een ongeldige
apply_patch-opmaak voor dit statusbestand is gecorrigeerd; dat was geen
controleweigering. Volledige gate, echte vendors/PTY, Linux en onafhankelijke
R4 blijven aan lead.
