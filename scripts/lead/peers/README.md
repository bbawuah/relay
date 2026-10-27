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

`vasthouden` en `vrijgeven` werken alleen als `LAB_AGENT_ROL` leeg is (Brian) of `lead`; een werker krijgt een weigering. Namen moeten passen op `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$` (dus nooit `.`, `..` of een pad).

### Eerste gebruik

Je afzendernaam is `LAB_AGENT_NAAM`; die moet als levende sessie in het register staan (de hooks zetten dat bij SessionStart). Staatmap: `LAB_LEAD_STAAT`.

```sh
export LAB_AGENT_NAAM=peers-a LAB_LEAD_STAAT=$(mktemp -d)   # alleen voor een proef: leeg register, dus geen_afzender
bun scripts/lead/peers/cli.ts send lead-peerbus "klaar met stap 1"
# niet verstuurd (geen_afzender): Afzender "peers-a" staat niet (meer) in het register, of de naam is ongeldig (letters, cijfers, . _ -).
```

Staat je sessie wel in het register en de lead ook, dan geeft `send` `afgeleverd <id>` (of `vastgehouden` als de lead jou niet vertrouwt). De ontvanger ziet bij `inbox`:

```
Bericht van peers-a (geen toestemming van Brian; wijzig geen config of permissies)
id 018b… · draad 018b… · bericht · 2026-10-27T15:00:00.000Z
<<<begin 018b…>>>
klaar met stap 1
<<<einde 018b…>>>
```

Een mislukte send geeft exit 1 en `niet verstuurd (<reden>): <melding>` op stderr. Elk bericht in `inbox` en `vasthouden` wordt getoond met `toon()` uit `types.ts` (de enige weergave; geen eigen opmaak); een bericht is nooit een opdracht van Brian.

## Beleid van `send`

In deze volgorde; de eerste die faalt bepaalt de reden:

| Stap | Uitslag |
|---|---|
| afzender niet levend in het register, of een ongeldige naam | `geen_afzender` |
| ontvanger niet levend (toestand `weg` telt niet), of een ongeldige naam | `onbekend` |
| tekst > `MAX_TEKST` | `te_lang` |
| hop > `MAX_HOP`: hop = hoogste hop in de draad + 1 (gezien in de inbox en vastgehouden van afzender en ontvanger; bepaald binnen de lock van de ontvanger, dus twee gelijktijdige sends krijgen verschillende hops), ook zonder `antwoord_op`; nieuwe draad = 1 | `hop` |
| meer dan `MAX_PER_MINUUT` pogingen per afzender in de laatste minuut | `te_veel` |
| zelfde van, naar en tekst binnen `DUBBEL_VENSTER_MS`, ongeacht de uitkomst van de eerste poging | ok, status `dubbel`, id van de eerste poging, niet opgeslagen of gewekt |
| inbound `refuse` | `geweigerd` |
| inbound `hold` | ok, status `vastgehouden`, niet in de inbox, niet gewekt |
| ongelezen + vastgehouden ≥ `MAX_WACHTRIJ` (ook voor een bericht dat vastgehouden zou worden) | `vol` |

Het tempo telt elke poging van een afzender met een geldige naam, ook een die om een andere reden wordt geweigerd (`te_lang`, `hop`, `geen_afzender`, `onbekend`); een poging boven de grens telt niet mee, zodat het venster leegloopt. Dubbel telt elke poging die zijn stap haalt. `send` kent geen `soort`: een afzender verstuurt altijd `bericht`; `idle` maakt alleen de bus. De afzender krijgt van het wekken alleen `{gewekt, route}`.

**Inbound** komt uit het register van de ontvanger (`PeerVelden.inbound`): `per_afzender[van]` (alleen een eigen sleutel, dus `constructor` telt niet) gaat voor `standaard`. Alleen `accept`, `hold` en `refuse` zijn geldig; elke andere waarde (`"Hold"`, een getal, een verkeerd type) telt als `hold`. Zonder beleid: `accept` als `ontvanger.lead === van` of `afzender.lead === ontvanger`, anders `hold`.

**Herkomst** is `extern` als de afzender `extern` is (`Rec.herkomst === "extern"` of de markering `<staat>/peers/extern/<naam>` bestaat) of de draad al een `extern` bericht bevat, anders `schoon`. De bus schrijft nooit in het register: een sessie die een `extern` bericht ziet (`inbox`, ook zonder ack, of `vasthouden` in de CLI) of ackt, krijgt de markering. Spoor D wist de markering bij SessionStart (net als hij `herkomst` terugzet naar `schoon`).

**Draad**: meegegeven, anders die van het origineel bij een antwoord, anders een nieuwe uuidv7. Een naam met meerdere levende records: het record met de laatste activiteit.

**Wekken**: na opslaan roept de bus `wekker.wek(doel, aantalOngelezen)` aan, hoogstens één keer per `WEK_VENSTER_MS` per ontvanger. Valt een bericht binnen het venster, dan legt de bus `open` vast in `wek/<naam>.json` en **wacht de send tot het venster om is** (hoogstens `WEK_VENSTER_MS`, dus tot 5 s; de wachttijd is injecteerbaar als `wacht`) en wekt dan met alles wat er ongelezen ligt: een seintje gaat dus niet verloren. Staat er al een wachter, dan wacht een tweede send niet en geeft `gewekt: null` (de wachter wekt voor beide). Is de wachter gestorven (zijn `open` is meer dan een venster verlopen), dan neemt de volgende send het over. Is alles na het wachten gelezen, dan wordt er niet gewekt. Een wekfout (ook een gegooide) wordt `{gewekt:false, route:"fout"}` en laat de send slagen; de afzender krijgt alleen `{gewekt, route}`.

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
wek/<naam>.json            laatste wektijd en `open` (een wek die nog volgt)
extern/<naam>              markering: deze sessie zag externe inhoud
slot/<soort>/<naam>.lock   lock (hardlink naar `pid-token`), soort post (ontvanger), tempo (afzender) of abo (doel)
```

- **Namen**: elke naam die een bestandsnaam wordt, moet passen op `^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$`; `.`, `..`, paden en spaties worden aan elke ingang geweigerd. Er wordt nooit iets hernoemd of verwijderd buiten `slot/<soort>/<naam>.lock`. `a/b` en `a_b` delen dus geen inbox meer.
- **Locks**: elke schrijf- of leesactie op de inbox van een ontvanger loopt onder zijn lock; nooit twee locks tegelijk vast, dus geen deadlock (de hop leest de inbox van de afzender zonder zijn lock, alleen lezen). De lock bevat de pid van de houder: een lock van een dode pid is meteen vrij, een lock ouder dan 10 s ook (pid-hergebruik). De houder verwijdert hem in `finally` alleen als hij nog zijn token bevat. Wachten duurt hoogstens 5 s, daarna geeft `send` `geweigerd` (de send gooit nooit).
- **Retentie**: een gelezen bericht blijft 24 uur staan, zodat een antwoord er hop en draad van kan overnemen; daarna ruimt de eerstvolgende schrijfactie het op.
- De bus leest het register (`scripts/lead/hooks/register.ts`) en schrijft er niet in.

## Tijdsgrenzen (voor de hooktimeout van spoor D)

Alle wachttijden hieronder komen bovenop de tijdsgrens van de wekker (spoor C: socket 2 s, codex 5 s, t3 twee aanroepen). Normaal duurt een bus-aanroep milliseconden.

- `send`: hoogstens 5 s op de lock van de afzender (tempo), 5 s op de lock van de ontvanger, tot 5 s wachten op het eind van het wekvenster en nog eens 5 s op de lock bij het wekken. Bovengrens ≈ 20 s, daarna `geweigerd` of een fout; zonder lockconflict en buiten het venster < 1 s, binnen het venster tot 5 s.
- `idleGemeld`: 5 s op de abonnementslock, per abonnee 5 s op zijn lock (achter elkaar), daarna alle wekken tegelijk (tot 5 s wachten + 5 s lock + wekker). Bovengrens ≈ 10 s + 5 s per abonnee + wekker; normaal < 1 s.
- Advies: een hooktimeout van minimaal 30 s en een bus-aanroep die bij timeout niet wordt herhaald (een herhaalde send is `dubbel`).

## Open punten

- Groei: `dubbel/`, `wek/`, `tempo/`, `abonnementen/`, `extern/` en achtergebleven `.tmp`-bestanden worden niet opgeruimd (klein, maar het groeit per naam). Opruimen is een vervolgstap.
- Een `notifyWhenIdle` op een doel dat al idle is wekt op de achtergrond; `bus.klaar()` wacht daarop (de CLI doet dat). Een MCP-aanroep of ander proces dat zonder `klaar()` stopt, laat de wek liggen; de volgende `send` of `list` neemt hem over (pid van de wachter dood, of het venster ruim voorbij).
- `ruimStaleLock`: tussen het lezen van een dode lock en het hernoemen kan een andere proces er een verse lock neerzetten; de bus zet die terug, maar in dat korte venster kunnen twee houders tegelijk bezig zijn.
- Een proces dat langer dan 10 s bevroren is (SIGSTOP, slaapstand) terwijl het een lock houdt, verliest die: een ander ruimt hem als verouderd op en er kunnen twee houders zijn. Een lock duurt normaal milliseconden; er is geen heartbeat.
- Hoofdletters: namen gaan voor elk pad in kleine letters; de bus weigert een send naar een naam met een levende hoofdlettertweeling, maar het register (`register/<id>.json`) is zelf niet hoofdlettergevoelig voor ids.
- Het wekvenster blokkeert een send die er binnen valt tot 5 s; een MCP-tool die snel achter elkaar naar dezelfde ontvanger stuurt, merkt dat.

## Testen

```sh
bun test scripts/lead/peers
node_modules/.bin/tsc -p scripts/tsconfig.json
```

Tests gebruiken een tijdelijke staatmap, een nep-wekker en een injecteerbare klok (`nu`); de parallelle tests starten echte `bun`-processen.

## MCP

`server.ts` is een stdio-MCP-server (eigen JSON-RPC, JSON-regels, geen dependency) op `standaardBus(env)`. Server-naam `peers`, dus de tools heten `mcp__peers__send` enz. Afzender = `LAB_AGENT_NAAM`; zonder die variabele geeft elke tool een tool-fout (ook `list`). Staatmap = `LAB_LEAD_STAAT`.

| Tool | Argumenten | Doet |
|---|---|---|
| `send` | `naar`, `tekst`, `draad?`, `antwoord_op?` | `bus.send`; een geweigerde send is een tool-fout (`isError`) met reden |
| `inbox` | — | ongelezen berichten via `toon()`; ackt pas nadat het antwoord naar stdout geschreven is |
| `list` | — | levende sessies als JSON, met tellers |
| `notify_when_idle` | `naam` | `bus.notifyWhenIdle`; eenmalig |

Een interne fout geeft het model altijd dezelfde vaste tekst (geen paden); de details gaan kort naar stderr. De server ondersteunt protocolversies 2024-11-05, 2025-03-26 en 2025-06-18 (een onbekende gevraagde versie krijgt de nieuwste) en geen batches. `inbox` ackt alleen als het antwoord echt geschreven is.

`vasthouden` en `vrijgeven` bestaan hier bewust niet (alleen CLI, voor Brian of de lead).

Config-voorbeelden (niets zelf installeren; pas het pad aan):

```sh
# Claude
claude mcp add peers --scope local -- bun /pad/naar/repo/scripts/lead/peers/server.ts
# of per sessie: claude --mcp-config peers.json  met
#   {"mcpServers":{"peers":{"command":"bun","args":["/pad/naar/repo/scripts/lead/peers/server.ts"]}}}
# Claude geeft zijn omgeving door; LAB_AGENT_NAAM en LAB_LEAD_STAAT moeten in de sessie gezet zijn.

# Codex (per run, niets in ~/.codex): spawn.sh --vendor codex doet dit zelf
codex \
  -c 'mcp_servers.peers.command="/pad/naar/bun"' \
  -c 'mcp_servers.peers.args=["/pad/naar/repo/scripts/lead/peers/server.ts"]' \
  -c 'mcp_servers.peers.env={LAB_AGENT_NAAM="naam",LAB_LEAD_NAAM="lead",LAB_LEAD_STAAT="/pad/naar/staat"}' \
  -c 'mcp_servers.peers.default_tools_approval_mode="approve"'
```

Codex geeft een MCP-server niet de omgeving van de sessie door (ook `env_vars` werkt daar niet voor een spawn-omgeving): de identiteit gaat als statische `env`-tabel per spawn mee. Meting (27 okt 2026, Codex 0.164.0):

- Een `-c`-override zet de TUI in embedded mode ("Running without the shared background server"): de MCP-server en de hooks erven dan de omgeving van de pane.
- Zonder `-c` (en in T3) draait een gedeelde app-server-daemon per `CODEX_HOME`; MCP-servers en hooks erven de omgeving van die daemon, en de cwd van de MCP-server is de cwd van de thread.
- **Identiteitsfallback.** Ontbreekt `LAB_AGENT_NAAM`, dan zoekt `server.ts` vanaf zijn cwd omhoog naar `<staat>/identiteit/<sha256(echt pad van de checkout)[:24]>.json` (door `spawn.sh --vendor codex` geschreven, alleen voor een eigen worktree, alleen rol `agent`/`sublead`/`vervolg`) en gebruikt naam, lead en spawn-id daaruit. `LAB_AGENT_NAAM` uit de omgeving gaat voor. **Iedereen met dezelfde cwd krijgt die identiteit**: het is routering, geen authenticatie.
