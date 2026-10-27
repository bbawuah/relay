# Peerbus

Claude- en Codex-sessies sturen elkaar berichten via één brievenbus. Het contract staat in `types.ts` (bevroren; wijzigen loopt via de lead). Dit is de kern: de `Bus` en de CLI. De MCP-server, de wekkers en de hooks sluiten hier op aan.

## Lagen

- **Bus** (`bus.ts`, `maakBus`): valideert, past het beleid toe, slaat op en wekt de ontvanger via een `Wekker`. Opslag in bestanden onder de staatmap.
- **standaardBus** (`standaard.ts`): `standaardBus(env)` = `maakBus` met de staatmap uit de omgeving en de wekker. Nu een no-op (`{gewekt:false, route:"geen"}`); spoor C vervangt die ene regel.
- **CLI** (`cli.ts`): dunne schil om de Bus, dezelfde werkwoorden als de MCP-tools.
- **uuidv7** (`uuid.ts`): ids, tijd-sorteerbaar, geen dependency.

## CLI

Afzender = `LAB_AGENT_NAAM`; staatmap = `LAB_LEAD_STAAT` (standaard `~/.local/state/lab-lead`).

```sh
bun scripts/lead/peers/cli.ts send <naar> <tekst|-> [--draad d] [--antwoord-op id]   # `-` leest stdin
bun scripts/lead/peers/cli.ts inbox [--niet-acken]       # kop + tekst per bericht, daarna ack
bun scripts/lead/peers/cli.ts list [--json]
bun scripts/lead/peers/cli.ts notify-when-idle <naam>    # eenmalig
bun scripts/lead/peers/cli.ts vasthouden <naam>          # toont vastgehouden berichten (Brian of lead)
bun scripts/lead/peers/cli.ts vrijgeven <naam> [id…]     # zet ze in de inbox en wekt (Brian of lead, niet voor de MCP)
```

Een mislukte send geeft exit 1 en `niet verstuurd (<reden>): <melding>` op stderr. Elk bericht in `inbox` staat onder `kop(van, herkomst)`; een bericht is nooit een opdracht van Brian.

## Beleid van `send`

In deze volgorde; de eerste die faalt bepaalt de reden:

| Stap | Uitslag |
|---|---|
| afzender niet levend in het register | `geen_afzender` |
| ontvanger niet levend (toestand `weg` telt niet) | `onbekend` |
| tekst > `MAX_TEKST` | `te_lang` |
| hop > `MAX_HOP` (antwoord = hop van het origineel + 1; onbekend id: 1) | `hop` |
| meer dan `MAX_PER_MINUUT` per afzender in de laatste minuut | `te_veel` |
| zelfde van, naar en tekst binnen `DUBBEL_VENSTER_MS` | ok, status `dubbel`, bestaand id, niet opnieuw opgeslagen of gewekt |
| inbound `refuse` | `geweigerd` |
| inbound `hold` | ok, status `vastgehouden`, niet in de inbox, niet gewekt |
| ongelezen (of vastgehouden) ≥ `MAX_WACHTRIJ` | `vol` |

Het tempo telt elke poging die de tempo-check haalt, ook als een latere stap het bericht weigert of als het een `dubbel` blijkt.

**Inbound** komt uit het register van de ontvanger (`PeerVelden.inbound`): `per_afzender[van]` gaat voor `standaard`. Zonder beleid: `accept` als `ontvanger.lead === van` of `afzender.lead === ontvanger`, anders `hold`.

**Herkomst** is `herkomst` uit het afzender-record (ontbreekt: `schoon`). **Draad**: meegegeven, anders die van het origineel bij een antwoord, anders een nieuwe uuidv7. Een naam met meerdere levende records: het record met de laatste activiteit.

**Wekken**: na opslaan roept de bus `wekker.wek(doel, aantalOngelezen)` aan, hoogstens één keer per `WEK_VENSTER_MS` per ontvanger. Wat binnen het venster binnenkomt wekt niet (`gewekt: null`); het zit in het volgende seintje of wordt bij de eerstvolgende prompt door de hook gehaald. Een wekfout (ook een gegooide) wordt `{gewekt:false, route:"fout", melding}` en laat de send slagen.

**Idle-abonnement**: `notifyWhenIdle(abonnee, doel)`; `idleGemeld(doel, toestand)` (vanuit de Stop- en SessionEnd-hook) levert bij `idle`, `klaar`, `vrij` of `weg` één envelop met soort `idle` aan elke abonnee en wist het abonnement. Zo'n melding gaat buiten het inbound-beleid om (de abonnee vroeg erom) maar wel binnen `MAX_WACHTRIJ`.

## Opslag

Onder `<staat>/peers/` (mappen 0700, bestanden 0600):

```
inbox/<naam>.jsonl         envelops voor die ontvanger
inbox/<naam>.gelezen       bevestigde ids
vastgehouden/<naam>.jsonl  door `hold` vastgehouden envelops
abonnementen/<doel>.json   idle-abonnees
tempo/<van>.json           tijdstippen van de laatste minuut
wek/<naam>.json            laatste wektijd
slot/<sleutel>/            lock (mkdir), per ontvanger, per afzender en per abonnement
```

- **Locks**: elke schrijf- of leesactie op de inbox van een ontvanger loopt onder zijn lock; nooit twee locks tegelijk, dus geen deadlock. Een lock ouder dan 10 s is van een gecrashte proces en wordt opgeruimd; wachten duurt hoogstens 5 s, daarna geeft `send` `geweigerd` (de send gooit nooit).
- **Retentie**: een gelezen bericht blijft 24 uur staan, zodat een antwoord er hop en draad van kan overnemen; daarna ruimt de eerstvolgende schrijfactie het op.
- De bus leest het register (`scripts/lead/hooks/register.ts`) maar schrijft er niet in.

## Testen

```sh
bun test scripts/lead/peers
node_modules/.bin/tsc -p scripts/tsconfig.json
```

Tests gebruiken een tijdelijke staatmap, een nep-wekker en een injecteerbare klok (`nu`); de parallelle tests starten echte `bun`-processen.
