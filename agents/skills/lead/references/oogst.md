## Wekelijkse oogst (flowplan stap 2)

**Wekelijkse oogst.** Kijk bij de start (sectie 1) in `lead.md` wanneer de laatste regel
`oogst:` was. Is dat meer dan 7 dagen geleden en is het geen stiltevenster? Laat dan een
subagent (geen worktree; alleen lezen en een verslag schrijven) dit doen:
1. Lees de gemergede PR's van de periode (`gh pr list --state merged --search "merged:>=<datum>"`),
   reverts en fix-commits (`git log --since`), `lead.md` en `lead-state.md`.
2. Groepeer correcties en fixes op **oorzaak**, niet op symptoom. Noteer per soort hoe vaak hij
   voorkwam, met PR's of SHA's.
3. Stel voor elke soort die twee keer of vaker voorkomt een check voor op de hoogste trede.
   Bewijs die op de echte oude commit (hij moet daar afgaan, zodat hij als kanarie in de
   zelftest past). De foutmelding noemt de oplossing. Is het patroon wijdverbreid, dan gaat het
   in de baseline.
4. Meet: het aantal merges, het aandeel met een fix binnen 7 dagen, het aantal herhaalde
   soorten, het aantal rijen "niets" in de regeltabel, en hoe vaak checks uit eerdere oogsten
   een PR tegenhielden. Tel ook het verbruik per sessie/spoor en per model uit
   `~/.claude/projects/*/*.jsonl` (usage: input, cache read/write, output; gewogen naar API-prijs),
   zodat Brian op cijfers kan kiezen tussen Max 5x en 20x.
5. Schrijf het verslag naar `~/vault-b-status/flowplan/oogst-<JJJJ-MM-DD>.md`.

Daarna: verdeel de voorgestelde checks als gewone opdrachten (sectie 3), en schrijf in
`lead.md` één regel `oogst: <datum> <n merges>, <n met fix>, <n herhaald>, <n niets>`.
