---
name: retro
description: Kijk terug op één of meer eerdere Claude-sessies (sessielogs) en maak een kort verslag met vondsten, bewijs en per vondst de trede waarop de oplossing hoort (architectuur, poortstap/lint, regel in AGENTS.md, review). Gebruik dit alleen als Brian of de lead er expliciet om vraagt, bv. "retro", "doe een retro op sessie X", "kijk terug op tmux-regie", "wat ging er mis in die sessie", "waarom verbruikte die sessie zoveel". Draait nooit automatisch (geen cron, geen hook, niet na elke sessie) en voert nooit zelf wijzigingen door; de mens beslist.
user_invocable: true
---

# Retro op sessielogs

Je leest wat er in een sessie echt gebeurde en stelt voor wat een volgende keer
voorkomt. Brian of de lead beslist wat er met een vondst gebeurt. Jij schrijft alleen
het verslag. Antwoord in het Nederlands, kort.

Grenzen, altijd:
- Nooit automatisch. Alleen op een expliciet verzoek, bij voorkeur steekproefsgewijs op
  recente of mislukte sessies (valse positieven en een driftende repo zijn het risico).
- Niets doorvoeren: geen wijzigingen aan AGENTS.md, hooks, poort, ruleset of code. Alleen
  het verslag, plus een voorstel per vondst.
- Geen berichtinhoud, denkwerk of geheimen kopiëren, niet in het verslag en niet in je
  antwoord. Alleen toolnamen, tijden, aantallen, bestandsnamen en korte foutregels
  (max ~110 tekens, geheimen weggestreept).
- Gebruik je eigen oordeel: een vondst die het script "ernstig" noemt kan meevallen.
  Eén keer gezien is een signaal; pas bij twee keer dezelfde oorzaak is het een
  ontbrekende check (drempelregel uit flowplan).

## 1. Sessies vinden

Logs staan in `~/.claude/projects/<projectmap>/<sessie-id>.jsonl`. De projectmap is het
pad met `-` voor `/`. Subagents van een sessie staan in
`<projectmap>/<sessie-id>/subagents/agent-*.jsonl`.

```sh
python3 ~/.claude/skills/retro/scripts/sessie-samenvatting.py zoek --slug tmux-regie --dagen 3
python3 ~/.claude/skills/retro/scripts/sessie-samenvatting.py zoek --project lab-bawuah --max 15
```

`zoek` toont id, sessienaam (de `-n`-naam of slug), grootte en aantal subagent-logs,
nieuwste eerst. Vraag bij meerdere treffers welke bedoeld is; raad niet.

## 2. De log lezen zonder de context te vullen

Logs zijn 1-5 MB. Lees ze nooit met Read of cat. Draai het script en werk met de
samenvatting:

```sh
python3 ~/.claude/skills/retro/scripts/sessie-samenvatting.py samenvat <id-of-prefix>
```

Per hoofdsessie en per subagent geeft het: tijdspanne en stiltes (>20 min), beurten,
model, compactie, usage (invoer, uitvoer, cache lezen/schrijven), toolgebruik per naam,
identieke aanroepen >=3x, vaak herlezen bestanden (basename), fouten gegroepeerd per
tool, weigeringen (hook, classifier, permissie), stop-hooks met fout, en resultaten
>20k tekens. Alleen als een regel verdacht is, zoek je gericht verder (bv.
`grep -c` op een toolnaam, of `jq` op één tijdstip) en citeer je hooguit de foutregel.
Lees nooit een hele tool-result of een hele beurt.

Tokens in dollars: gebruik `scripts/meting/verbruik.ts` in de repo (`bun run meting`,
leest dezelfde logs, telt subagents bij de oudersessie mee, zie
`scripts/meting/README.md`). Het script hier geeft ruwe aantallen om te vergelijken.
Rekenen kost veel: lees het herlezenAandeel (cache lezen) en de startcontext als
indicator, niet je eigen schatting.

## 3. Categorieën (checklist)

Loop ze af; sla over wat niets oplevert.
1. **Omwegen**: veel tool-aanroepen voor iets kleins, zoeken op de verkeerde plek.
2. **Herhaalde fouten**: dezelfde fout of dezelfde correctie twee keer of meer.
3. **Tokenverspilling**: grote tool-resultaten, hetzelfde bestand vaak herlezen, een
   eigen CLI of script met te veel uitvoer, een duur model voor een klein werk.
4. **Ontbrekende checks**: iets handmatig gecontroleerd dat een poortstap hoort te doen;
   een script dat nergens draait.
5. **Regels die niets doen (no-ops)**: een regel in AGENTS.md of skill die genegeerd
   werd, of waar niets op afdwingt.
6. **Ontbrekende informatie**: de agent zocht of vroeg wat al ergens had moeten staan.
7. **Contextverlies**: na compactie dezelfde instructie opnieuw, herhaalde aanwijzing.
8. **Grensgevallen**: weigeringen van hook of classifier, een onomkeerbare of publieke
   actie zonder te vragen, aanraken van andermans bestanden of sleutels.
9. **Gezondheid van AGENTS.md/skills**: te lang, tegenstrijdig, verouderd.

## 4. Trede per vondst

Kies de hoogste trede waarop het past (flowplan/PLAN.md):
1. **Architectuur**: de fout kan niet meer (type, ruleset, wegwerp-omgeving, andere opzet).
2. **Poortstap of lint**: een check met zelftest-kanarie die afgaat op de echte oude fout.
3. **Regel in AGENTS.md**, met erbij wat hem afdwingt (anders is het een no-op).
4. **Review**: alleen als niets hoger kan.

Eén keer gezien en niet te automatiseren: trede 4 of "alleen noteren". Twee keer
dezelfde oorzaak (ook over eerdere retro's of de oogst): trede 1-2 voorstellen.

## 5. Verslag

Pad: `~/vault-b-status/flowplan/retro-<jjjj-mm-dd>-<onderwerp>.md` (onderwerp = sessienaam,
kort, kleine letters met streepjes). Maximaal ~80 regels, Nederlands, kale toon zoals
`oogst-2026-10-05.md`.

```
# Retro <datum>: <sessie(s)>
Bron: sessie-id's, periode, aantal beurten; alleen gelezen, niets gewijzigd.

## TL;DR
- 3-5 punten: wat ging goed, wat kostte het meest, wat de top 1-3 vondsten zijn.

| # | Vondst | Bewijs (tijd, tool) | Trede | Voorstel |
|---|---|---|---|---|
| 1 | korte omschrijving + categorie | 11:42 Bash x4 "Exit code 1" | 2 poortstap | check X die afgaat op ... |

## Cijfers
Beurten, modelmix, cache-lezen-aandeel, groot resultaat, stiltes.

## Niet gevonden / twijfel
Wat je niet kon bewijzen en welke vondst mogelijk een valse positieve is.
```

Elk voorstel noemt (indien trede 1-2) waar de check op af moet gaan en welke
foutmelding de oplossing noemt. Geen voorstel zonder bewijsregel. Sluit je antwoord af
met het pad en de top 3; laat de beslissing aan Brian of de lead.
