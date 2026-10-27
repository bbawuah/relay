# Beleidslaag (fase 1)

Eén bron voor wat Claude (en straks Codex) aan hooks krijgt. Plan en contract: `~/vault-b-status/peerbus/PLAN-beleidslaag.md` en `CONTRACT-beleidslaag.md`.

| Bestand | Rol |
|---|---|
| `typen.ts` | De typen (contract; wijzigen alleen via de lead) |
| `beleid.ts` | De bron: lead-hooks per event en de grenzen-hook |
| `hosts.ts` | Vertaaltabel per host (Claude ingevuld, Codex `null` tot fase 2) |
| `claude.ts` | Pure `genereer(beleid, "claude", opties)` naar de nieuwe `settings.json` |
| `../installeer-hooks.ts` | Dunne wrapper: zelfde CLI (`--droog`, `--verwijder`, `--met-wekker`) en uitvoer als voorheen |

## Fase 1: geen gedragsverandering
- `installeer-hooks.ts` geeft byte-gelijke uitvoer en bestanden als de versie van main (39031c68), bewezen in `beleid.test.ts` tegen de bevroren kopie `fixtures/installeer-hooks-oud.ts`.
- De grenzen-hook staat in de bron, maar de installer zet hem nog niet (`metGrenzen` staat uit): Brian heeft die entry met de hand. Met `metGrenzen` neemt de generator een bestaande, ongemarkeerde `grenzen.sh`-entry over (één entry, gemarkeerd `LAB_BELEID_ID=grenzen`); dat is voor fase 2.
- Markering: lead-hooks behouden `lab-lead-hooks/hook.sh` in het commando (bestaande installaties blijven "eigen"); nieuwe entries krijgen `LAB_BELEID_ID=<id>`.
- Snapshots in `fixtures/claude-*.json`: opnieuw maken met `BELEID_FIXTURES=1 bun test scripts/lead/beleid` en de diff nalopen.
