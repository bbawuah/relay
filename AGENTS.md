# relay

Deze repository bevat generieke orchestratielogica. Projectspecifieke checks,
PR-regels en skills staan in `relay.toml` van het project.

Controleer wijzigingen met `bun run poort`. Houd productintegraties buiten
relay; leg een onvermijdelijk uitgesloten producttest per bestand vast in
`TESTS-UITGESLOTEN.md`.
