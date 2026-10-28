# relay

Zelfstandige lead-, worker-, peerbus- en beleidsautomatisering, los van een
productrepository.

## Lokaal controleren

Na een clone:

```sh
bun install
bun test
bun run typecheck
bun run poort
```

`poort` voert de volledige relay-testsuite uit, typecheckt de zelfstandige
relay-bronnen en controleert dat de twee verplichte hookbestanden aanwezig
zijn. De poort gebruikt geen productpaden of project-specifieke packages.

`relay.toml` is het voorbeeldcontract voor een project dat relay gebruikt;
projectspecificieke checks en regels horen daar, niet in deze repository.

Zie [TESTS-UITGESLOTEN.md](TESTS-UITGESLOTEN.md) voor de bewaarde,
productgebonden tests die bewust niet in deze zelfstandige suite draaien.
