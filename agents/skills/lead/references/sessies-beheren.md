# Sessies beheren: toestand, namen, doorvoer, overleg, geheugen

Uit SKILL.md verhuisd op 27 okt 2026 (oude versie: `SKILL.md.voor-kort`).

## Toestand van je sessies

De hooks (`scripts/lead/hooks/`, README bij `scripts/lead`) houden per sessie en subagent een register
bij. `scripts/lead/status.sh [--lead <n>] [--alles] [--git] [--json]` toont het.

| Toestand | Betekenis |
|---|---|
| `bezig` | draait een beurt |
| `idle` | wacht op invoer (gestopt zonder rapport, of idle-melding) |
| `goedkeuring` | wacht op een permissieprompt; kijk in de pane, laat Brian of jezelf beslissen |
| `klaar` | rapport aan jou is binnen |
| `vrij` | rapport binnen en de sessie schreef "vrij": nieuwe opdracht geven of sluiten |
| `vastgelopen` | API-fout, of `bezig ?` zonder tool-event > 20 min / `goedkeuring` > 10 min |
| `weg` | beëindigd (24 uur zichtbaar met `--alles`) |

- Meldingen ("w2 klaar", "w2 wacht op goedkeuring") komen vanzelf bij je volgende prompt en je Stop.
  Niet pollen met ListAgents of capture-pane.
- `klaar` zonder `vrij`: rapport binnen, afronding (opruimen) nog open.
- Wie stopt zonder `SendMessage` naar jou, wordt hoogstens 3 keer tegengehouden; daarna een melding.
- Sessies zonder `LAB_AGENT_ROL` (losse sessies van Brian) staan niet in het register.

## Namen

- Start de lead met de zsh-functie `lead <onderwerp>` (zet `LAB_LEAD=1 LAB_AGENT_ROL=lead` en een unieke
  `LAB_AGENT_NAAM`/`LAB_LEAD_NAAM`). Twee leads met dezelfde naam krijgen elkaars meldingen.
- Ben je zonder die functie gestart: je echte naam staat bovenaan `ListAgents` ("This session is …").
  Geef die aan `spawn.sh --lead <naam>`; een verzonnen naam laat rapporten verdwijnen (27 okt).
- Hernoemen: `bun scripts/lead/hernoem.ts --sessie <id> --naam <n> --volgers a,b` plus `/rename <n>`.
- Zonder de startregel kennen de hooks je niet: `tmux set -p -t "$TMUX_PANE" @agent_rol lead; tmux set -p -t "$TMUX_PANE" @agent_naam <naam>`.

## Doorvoer zonder verspilling (Brian, Max 20x sinds 6 okt 2026)

Brian wil het plafond van parallel werk doorbreken: zoek het knelpunt (poort, merge, review, lead, mini),
adviseer geen maximum. Zuinig alleen tegen verspilling (5 okt: ~76% van het gewicht was herlezen van
lange contexten):
- `model` per `Agent`: lezen/zoeken/review → `sonnet` of `haiku`; bouwen → `sonnet`; Opus alleen als
  het echt lastig is. Fable telt zwaar in de weeklimiet: alleen bewust. Lead en eindreview: Opus.
- Korte sessies: na merge en opruimen sluiten, nieuw werk in een verse sessie die alleen de OPDRACHT leest.
- Niet wachten in een lus: één `--watch` of achtergrondtaak. Idle sessies zonder werk sluiten.
- Meld Brian alleen als de dagmeting (`bun run meting`) richting de weeklimiet loopt.

## Overleg tussen sporen

- Sessies mogen elkaar rechtstreeks berichten voor uitvoering binnen het contract (waarden, veldnamen).
- Wijzigingen aan de interface in PLAN.md of aan het contract lopen via de lead; die meldt ze aan alle
  sporen die het raakt. Wie rechtstreeks iets afspreekt, meldt de lead in één regel.
- Subagents praten via hun ouder. Geen toestemming doorgeven: wat bij de ene geweigerd is, vraagt
  ze niet aan een andere; dat gaat naar Brian.
- Noem in elke opdracht welke sessies tegelijk lopen, met namen.

## Uitrol

Uitrol en het herstarten van diensten weigert de veiligheidscheck meestal. Geen omweg: geef Brian het
exacte commando (`! <commando>`) en controleer daarna zelf (launchctl, health-endpoint, rooktest).

## Geheugen

- Na elke mijlpaal één regel in `~/vault-b-status/lead.md`: `- <dag> <HH:MM> <wat, met SHA/PR>`.
  Boven 80 KB roteren naar `archief/lead-<van>-tot-<tot>.md` (regels tellen vóór en na).
- Koerswijziging: `lead-state.md` bijwerken. Blijvende les: Claude-memory (feedback). Iets voor maanden: de vault.
- Bestanden buiten git (deze skill, `~/.claude/*`): eerst een backup `<bestand>.voor-<reden>`, daarna een regel in lead.md.

## Correcties omzetten in checks (flowplan)

Kies bij elke correctie de hoogste trede: architectuur (fout onmogelijk maken), poortstap of lint,
regel in `AGENTS.md` met wat hem afdwingt, en pas als laatste review. Een soort fout telt na twee keer
dezelfde oorzaak. Plan: `~/vault-b-status/flowplan/PLAN.md`. Wekelijkse oogst: `sessies-en-oogst.md`.
Opdrachten met een zichtbare wijziging aan tmux of watchparty eisen `bun run bekijk <app>` vóór "klaar".
