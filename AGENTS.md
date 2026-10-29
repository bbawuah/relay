# relay

Deze repository bevat generieke orchestratielogica. Projectspecifieke checks,
PR-regels en persoonlijke skills horen bij het project dat Relay gebruikt.
`relay.toml` is voorlopig een ontwerpvoorbeeld, geen actieve runtimeconfiguratie.

Controleer wijzigingen met `bun run poort`. Houd productintegraties buiten
relay; leg een onvermijdelijk uitgesloten producttest per bestand vast in
`TESTS-UITGESLOTEN.md`.

De ondersteunde ingang is `bin/relay.ts` met `src/`. Bewaar de peerbuscontracten
en de servernaam `peers`; bronherkomst staat in `docs/source-manifest.json`.
Installeer of test nooit tegen live state, een live tmux-socket of bestaande
gebruikersinstellingen. Gebruik tijdelijke HOME/state/prefix en eigen sockets.
