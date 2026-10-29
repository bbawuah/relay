# relay

Zelfstandige launchers, sessiestatus en lokale peerberichten, los van een
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

De korte vorm opent een Codex-sessie met de bestaande providerconfiguratie; een taak is optioneel. Vanuit
de hoofdcheckout maakt Relay een sibling-worktree `<repo>-codex-lead` op
`lead/codex`; vanuit een linked worktree gebruikt hij die direct.
Ook buiten een Git-map werkt `relay codex`: dan gebruikt Relay zijn eigen
checkout als terugval.

```sh
relay codex
relay codex "onderzoek de falende test"
```

`relay codex -l [prompt]` blijft een compatibele alias. Een afgebakende
werker gebruikt bewust de expliciete vorm `relay codex -w <naam> <opdracht>`:
die heeft een eigen worktree en een controleerbare opdracht nodig.

De gewone suite gebruikt geen modeloproepen. `scripts/lead/peers/e2e/codex-demo.ts` is een afzonderlijke opt-in demonstratie met een lokale nep-Responses-server; dit is geen live-activeringstest en is tijdens deze opdracht niet uitgevoerd.

Zie [TESTS-UITGESLOTEN.md](TESTS-UITGESLOTEN.md) voor de bewaarde,
productgebonden tests die bewust niet in deze zelfstandige suite draaien.

Agentrollen verlenen geen privileges. Nieuwe peerberichten worden direct afgeleverd, ook tussen niet-gerelateerde sessies en met oude inboundwaarden. Historische heldpost vereist expliciet herstel via de CLI. Zie [inventaris](docs/policy-reset/INVENTARIS.md), [activering en herstel](docs/policy-reset/ACTIVERING.md) en [testpensioen](scripts/lead/TESTPENSIOEN.md).
