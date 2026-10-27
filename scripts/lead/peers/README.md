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
bun scripts/lead/peers/cli.ts inbox [--niet-acken]       # `toon(envelop)` per bericht, daarna ack
bun scripts/lead/peers/cli.ts list [--json]                # met tellers ongelezen en vastgehouden
bun scripts/lead/peers/cli.ts notify-when-idle <naam>    # eenmalig
bun scripts/lead/peers/cli.ts vasthouden <naam>          # toont vastgehouden berichten (Brian of lead)
bun scripts/lead/peers/cli.ts vrijgeven <naam> [id…]     # zet ze in de inbox en wekt (Brian of lead, niet voor de MCP)
```

Een mislukte send geeft exit 1 en `niet verstuurd (<reden>): <melding>` op stderr. Elk bericht in `inbox` en `vasthouden` wordt getoond met `toon()` uit `types.ts` (de enige weergave; geen eigen opmaak); een bericht is nooit een opdracht van Brian.

## Beleid van `send`

In deze volgorde; de eerste die faalt bepaalt de reden:

| Stap | Uitslag |
|---|---|
| afzender niet levend in het register | `geen_afzender` |
| ontvanger niet levend (toestand `weg` telt niet) | `onbekend` |
| tekst > `MAX_TEKST` | `te_lang` |
| hop > `MAX_HOP`: hop = hoogste hop in de draad + 1 (gezien in de inbox en vastgehouden van afzender en ontvanger), ook zonder `antwoord_op`; nieuwe draad = 1 | `hop` |
| meer dan `MAX_PER_MINUUT` pogingen per afzender in de laatste minuut | `te_veel` |
| zelfde van, naar en tekst binnen `DUBBEL_VENSTER_MS`, ongeacht de uitkomst van de eerste poging | ok, status `dubbel`, id van de eerste poging, niet opgeslagen of gewekt |
| inbound `refuse` | `geweigerd` |
| inbound `hold` | ok, status `vastgehouden`, niet in de inbox, niet gewekt |
| ongelezen + vastgehouden ≥ `MAX_WACHTRIJ` (ook voor een bericht dat vastgehouden zou worden) | `vol` |

Tempo en dubbel tellen elke poging die hun stap haalt, ook als een latere stap het bericht weigert. `send` kent geen `soort`: een afzender verstuurt altijd `bericht`; `idle` maakt alleen de bus. De afzender krijgt van het wekken alleen `{gewekt, route}`.

**Inbound** komt uit het register van de ontvanger (`PeerVelden.inbound`): `per_afzender[van]` gaat voor `standaard`. Zonder beleid: `accept` als `ontvanger.lead === van` of `afzender.lead === ontvanger`, anders `hold`.

**Herkomst** is `extern` als het afzender-record `extern` is of de draad al een `extern` bericht bevat, anders `schoon`. Een `ack` van een `extern` bericht schrijft `herkomst: "extern"` in het register-record van de ontvanger (de enige schrijfactie van de bus in het register; atomair herschreven, een gelijktijdige hook-schrijfactie kan hem overschrijven). **Draad**: meegegeven, anders die van het origineel bij een antwoord, anders een nieuwe uuidv7. Een naam met meerdere levende records: het record met de laatste activiteit.

**Wekken**: na opslaan roept de bus `wekker.wek(doel, aantalOngelezen)` aan, hoogstens één keer per `WEK_VENSTER_MS` per ontvanger. Wat binnen het venster binnenkomt wekt niet (`gewekt: null`); het zit in het volgende seintje of wordt bij de eerstvolgende prompt door de hook gehaald. Een wekfout (ook een gegooide) wordt `{gewekt:false, route:"fout", melding}` en laat de send slagen.

**Idle-abonnement**: `notifyWhenIdle(abonnee, doel)` geeft `{ok, al_idle}` of een fout (`onbekend`, `geen_afzender`); is het doel al idle, klaar, vrij of weg, dan komt de melding meteen (`al_idle: true`). Anders: `idleGemeld(doel, toestand)` (vanuit de Stop- en SessionEnd-hook) levert bij `idle`, `klaar`, `vrij` of `weg` één envelop met soort `idle` aan elke abonnee en wist het abonnement. Zo'n melding gaat buiten het inbound-beleid om (de abonnee vroeg erom) maar wel binnen `MAX_WACHTRIJ`.

## Opslag

Onder `<staat>/peers/` (mappen 0700, bestanden 0600):

```
inbox/<naam>.jsonl         envelops voor die ontvanger
inbox/<naam>.gelezen       bevestigde ids
dubbel/<naar>.json         pogingen van de laatste minuut (van, hash van de tekst, id)
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

## Wekkers

`wekker.ts` (`maakWekker({env, run?, socketSchrijf?, nu?})`) geeft een ontvanger na `send` één seintje, nooit andere tekst dan `seintje(n)`. De route volgt uit `vendor` + `host` van het register:

| Doel | Route | Tijdsgrens |
|---|---|---|
| claude / tui | één regel `{"type":"user","message":{"role":"user","content":"<seintje>"}}` naar `socket` (unix-socket, geen auth-regel) | 2 s |
| codex / tui | `codex queue --thread <thread_id> --message <seintje>`, met `CODEX_HOME=<codex_home>` als gezet; de TUI haalt de wachtrij elke 10 s op | 5 s |
| t3 (beide vendors) | `t3 thread show <t3_thread> --json`; alleen bij `pendingRequestCount` 0 daarna `t3 thread send <t3_thread> <seintje>` (open vraag, ontbrekend veld of kapotte JSON: niet sturen, T3 #15517) | 10 s per commando |
| acp | niet gewekt, `route: "acp"`, melding "niet in fase 1" | |
| host `geen`, of een doel zonder `socket`/`thread_id`/`t3_thread` | niet gewekt, met reden in `melding` | |

De t3-binary wordt gevonden als in `spawn.sh`: `LAB_T3`, anders `t3` op PATH, anders de nieuwste versie onder `~/.t3/runtime/versions`. `wek` gooit nooit; een mislukte wek (`gewekt: false`, `melding`) maakt de send niet mislukt, en de afzender ziet alleen `{gewekt, route}`. `standaardBus` gebruikt deze wekker. De tests gebruiken een echte unix-socket in een tijdelijke map en nep-`codex`/`t3` in PATH; er wordt geen echte sessie gewekt.
