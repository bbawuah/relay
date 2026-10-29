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

## Codex starten

De korte vorm opent een gecontroleerde Codex-lead; een taak is optioneel:

```sh
relay codex
relay codex "onderzoek de falende test"
```

`relay codex -l [prompt]` blijft een compatibele alias. Een afgebakende
werker gebruikt bewust de expliciete vorm `relay codex -w <naam> <opdracht>`:
die heeft een eigen worktree en een controleerbare opdracht nodig.

De enige echte-Codex e2e-test is standaard overgeslagen, omdat hij een lokale
Codex-app-server en maximaal vier minuten wachttijd nodig heeft. Draai hem
bewust met `RELAY_E2E_CODEX=1 bun test scripts/lead/lead.test.ts`.

Zie [TESTS-UITGESLOTEN.md](TESTS-UITGESLOTEN.md) voor de bewaarde,
productgebonden tests die bewust niet in deze zelfstandige suite draaien.
