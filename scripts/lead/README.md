# Lead-scripts

Drie scripts voor de lead: een sessie starten met een opdrachtbestand, een PR mergen zonder de voorwaarden te vergeten, en een merge-wachtrij die meerdere goedgekeurde PR's als één integratie-PR door de poort haalt. Alle kennen `--droog` (laat zien wat er zou gebeuren, doet niets).

## spawn.sh

Start `claude` in een nieuw tmux-venster via `~/.claude/tmux/agent-spawn.sh`, wacht tot de sessie invoer aanneemt, typt de vaste startzin en controleert dat de sessie aan het werk gaat.

```sh
scripts/lead/spawn.sh --naam w2 --opdracht ~/vault-b-status/werkwijze-b/CONTRACT.md \
  --model sonnet --map ~/Desktop/LAB-BAWUAH/lab-bawuah/.claude/worktrees/w2 --lead labbawuah-1c
scripts/lead/spawn.sh --naam w2 --opdracht opdracht.md --lead labbawuah-1c --droog
```

| Optie | Betekenis |
|---|---|
| `--naam <n>` | Naam van de sessie (`claude -n <n>`). Alleen letters, cijfers, `.`, `_` en `-`. |
| `--opdracht <bestand>` | Moet bestaan, anders weigert het script. De sessie krijgt het absolute pad (met spatie: tussen enkele quotes). Een pad met regeleinde of `'` wordt geweigerd. |
| `--model sonnet\|opus` | Optioneel; zonder de standaard van Claude Code. |
| `--map <pad>` | Werkmap van de sessie; standaard de huidige map. |
| `--lead <naam>` | Naam van de lead voor de startzin. Zonder: de naam van de aanroepende lead uit het register (via `TMUX_PANE`), anders env `LAB_LEAD_NAAM`. Draaien er twee levende leads met die naam, dan weigert het script ("geef --lead <unieke naam>"). |
| `--sublead` | Start een sub-lead: de startzin verwijst naar `scripts/lead/sublead.md` (bouwer, reviewer die niet plant, één herstelronde met de Agent-tool) en vraagt een korte melding (PR, sha, oordeel, open punten). |
| `--workflow <JJJJ-MM-DD>` | Alleen bij `--sublead`, en alleen als Brian workflows toestond op die datum (de lead noteert dat in `~/vault-b-status/lead.md`): de startzin zegt dat en wijst naar `scripts/lead/vaste-cyclus.js`. Zonder deze vlag staat er "Geen Workflow-tool." in de startzin. |
| `--vervolg <tak>` | Verse sessie op een bestaande tak (lokaal of `origin/<tak>` in `--map`, anders exit 1): de startzin laat haar alleen de opdracht en `git log`/diff van de tak lezen, geen oude context. Sluit `--sublead` uit. |
| `--droog` | Alleen tonen. |

Wat het doet:

1. Start `agent-spawn.sh window <map> "env LAB_AGENT_NAAM=<naam> LAB_AGENT_ROL=<agent|sublead|vervolg> LAB_LEAD_NAAM=<lead> LAB_OPDRACHT=<abs pad> claude -n <naam> [--model m]"`. Het voorvoegsel is de identiteit voor de hooks (zie "Hooks en `lead status`"); het opdrachtpad staat in het voorvoegsel (met spatie tussen enkele quotes), de startzin staat niet in de quotes van het commando. Direct na het starten zet het script `tmux set -p -t <pane> @agent_rol <rol>` en `@agent_naam <naam>`.
2. Wacht (max 60 s) tot `tmux capture-pane` "auto mode" of een lege invoerbox (`│ ❯`) toont. Toont de pane de vertrouwensvraag van Claude Code (de tekst "Quick safety check" / "Yes, I trust this folder"; andere vragen tellen niet), dan wacht het script: één melding aan Brian (`tmux display-message` op alle clients plus op stderr: "<naam> wacht op vertrouwen in pane %N (map <map>)"), daarna pollen tot de vraag weg is, max `WACHT_VERTROUWEN` seconden (standaard 600, env). Daarna gaat het door met de prompt-controle en de startzin. Het script beantwoordt de vraag nooit zelf (geen toets). Loopt de tijd af, dan exit 1 met pane, map en de startzin om met de hand te typen. Vooraf leest het (alleen lezen, jq) `.projects[<map of bovenliggende map>].hasTrustDialogAccepted` in `~/.claude.json` (env `LAB_CLAUDE_JSON` voor tests) en waarschuwt op stderr als de map niet vertrouwd is; er wordt nooit in dat bestand geschreven.
3. Typt met `tmux send-keys -l` de startzin: "Je lead is <lead>. Jij bent sessie <naam>. Lees <bestand> en voer die uit. Rapporteer aan de lead via SendMessage (to: <lead>)." en daarna Enter.
4. Wacht (max 30 s) op een tool-aanroep (`⏺`) in de pane. Zo niet: exit 1 met melding.
5. Print het pane-id (bijvoorbeeld `%12`) op stdout.

Het script moet binnen tmux draaien (dat eist `agent-spawn.sh`). Voor tests kunnen de wachttijden en het spawn-script worden overschreven: `LAB_SPAWN_SCRIPT`, `LAB_SPAWN_WACHT`, `LAB_SPAWN_POLS`, `LAB_SPAWN_BEWIJS` (hele getallen). `bun test scripts/lead/spawn-vertrouwen.test.ts` toetst het wachten met een echte tmux op een wegwerp-socket (`spawntest-<pid>`) en een nep-spawnscript.

## merge.sh

```sh
scripts/lead/merge.sh 71 --droog   # controleren
scripts/lead/merge.sh 71           # mergen
```

Weigert met exit 1 en een duidelijke reden als:

- de PR niet OPEN is;
- de PR uit een fork komt (`isCrossRepository`) of de tak `main`/`master` is;
- er geen PR-comment is die begint met "Lead-review: akkoord <sha7>", met de eerste 7 tekens van de huidige head. Een akkoord van vóór een nieuwe push telt dus niet ("push na akkoord"). Voorbeeld: `Lead-review: akkoord b80ed00`;
- de PR geen enkele CheckRun van workflow `CI` heeft (de Vercel-entries in de rollup tellen niet mee; GitHub startte soms geen CI bij een nieuwe PR: #85, #87, #88): de melding is `geen CI-run voor <sha7>; sluit en heropen de PR of push opnieuw`, geen "niet groen" en geen wachten;
- de verplichte check `poort` ontbreekt of niet groen is (de nieuwste run op starttijd telt; andere checks niet);
- `mergeable` niet `MERGEABLE` is, of de tak achterloopt op main (`BEHIND`, de ruleset is strict), of `mergeStateStatus` iets anders is dan CLEAN of UNSTABLE (allowlist). Bij UNSTABLE volgt een waarschuwing.

Zijn de voorwaarden in orde, dan: de merge met `--merge --match-head-commit <volledige head-sha>` (de head die net tegen het akkoord is getoetst; verschuift de head tussen controle en merge, dan weigert GitHub), daarna controleren dat `state` `MERGED` is, en pas dan `git push origin --delete <tak>`. Staat de PR niet op MERGED, dan blijft de remote tak staan en eindigt het script met exit 1.

### Bezitscheck (optioneel)

```sh
scripts/lead/merge.sh 71 --droog --contract ~/vault-b-status/werkwijze-b/CONTRACT-fase3.md --spoor D2
```

Leest de regel `Bezit: …` in de sectie `## <spoor> ·` van het contract, haalt de paden uit de stukken tussen backticks (een stuk telt als pad als het een `/` of `.` bevat; `scripts/lead/*.test.ts` is een patroon, `docs/` een map, een kaal `merge.sh` telt als bestandsnaam in welke map dan ook) en vergelijkt ze met de bestanden van de PR. Bestanden buiten het Bezit komen als waarschuwing op stderr; het mergen gaat door, de lead beslist. Zonder `--contract` en `--spoor` doet merge.sh niets extra's; één van de twee alleen, een onbekend spoor of een contract zonder paden in de Bezit-regel is een weigering.

Het script gebruikt `gh` en `jq` en pusht vanuit de huidige git-map; draai het vanuit een clone van de repo.

## wachtrij.ts

```sh
bun scripts/lead/wachtrij.ts --droog          # alleen laten zien
bun scripts/lead/wachtrij.ts                  # bouwen, poort draaien, integratie-PR openen
bun scripts/lead/wachtrij.ts --ruim-takken    # na MERGED: remote takken van de onderliggende PR's weg
```

Stappen:

1. Open PR's met een comment die begint met `Lead-review: akkoord <sha7>`, waarbij de sha7 de huidige head is. Forks, concepten en eerdere `wachtrij/`-PR's tellen niet; een verouderd akkoord wordt gemeld.
2. Tak `wachtrij/<jjjjmmdd-hhmm>` in een eigen worktree (naast de repo, `<repo>-wachtrij-<stempel>`) vanaf `origin/main`. De PR's worden in volgorde van nummer samengevoegd met `git merge --no-ff` van de echte head (dus geen squash: GitHub ziet de commits en sluit de onderliggende PR's als gemerged). Een conflict of een tak die na het akkoord is verschoven haalt die PR eruit, met een melding.
3. `bun install --frozen-lockfile && bun run poort --base <basis>` in de worktree (basis standaard `origin/main`): de volledige poort mét e2e. Rood of een poort die bestanden achterlaat = geen push, geen PR. De melding noemt wat er blijft staan (worktree, lokale tak, na een push ook de remote tak) en hoe je het opruimt; hetzelfde na een mislukte push of PR-aanmaak. In het stiltevenster 05:00–07:15 weigert het script (ook `--droog` meldt het).
4. Push en één integratie-PR met het sjabloon: Samenvatting (de lijst), Bewijs (`poort: groen (met e2e) op <sha7>: #n, #m` pas na de geslaagde run, plus de `OK bekijk <app>`-regels uit de onderliggende PR's, alleen van een PR die die app echt raakt) en Merge-gevaar (de sectie van de zwaarste onderliggende PR). Titels en Merge-gevaar-tekst uit de onderliggende PR's worden onschadelijk gemaakt (`OK bekijk` wordt `OK-bekijk`, `poort:` wordt `poort -`, marker- en akkoordregels vallen weg), zodat ze geen bewijsregel kunnen nabootsen. Een regel `Wachtrij-PR's: <nr>=<tak>=<sha> …` in de body is voor `--ruim-takken`.
5. **De lead controleert de lijst PR's in de integratie-PR** (ook bij een vaste lijst met `--prs`: wat samengevoegd is, wat eruit viel en waarom), geeft dan op de integratie-PR `Lead-review: akkoord <sha7>` en draait `merge.sh <pr>`.
6. `--ruim-takken [<pr>]` (zonder nummer: de laatste gemergede `wachtrij/`-PR): weigert als de PR niet MERGED is, en verwijdert per onderliggende PR de remote tak alleen als de head in `origin/main` staat én de remote tak nog op die sha staat. Standaard worden de takken dus niet verwijderd.

| Optie | Betekenis |
|---|---|
| `--droog` | Alleen tonen; ook bij `--ruim-takken`. |
| `--prs <n,n,…>` | Vaste lijst, bijvoorbeeld `--prs 81,82`: alleen deze PR's, in deze volgorde. Een genoemde PR zonder geldig akkoord valt af met reden. De lead controleert de lijst in de integratie-PR. |
| `--poort-cmd <cmd>` | Vervangt de standaardpoort (voor tests). De body zegt dan "geen e2e-bewijs" in plaats van "met e2e". |
| `--nu <jjjjmmdd-hhmm>` | Bepaalt alleen de naam van de tak (`wachtrij/<stempel>`). Het stiltevenster gaat altijd op de echte klok. |
| `--ci-wacht <s>` | Seconden (standaard 30, of env `LAB_WACHTRIJ_CI_WACHT`) die na het openen van de integratie-PR gewacht wordt op de eerste CI-CheckRun (`__typename` CheckRun, `workflowName` CI; Vercel-entries tellen niet). Is er dan nog geen, dan staat in de uitvoer `WAARSCHUWING: geen CI-run voor <sha7>; sluit en heropen de PR of push opnieuw`. |
| `--map <pad>` | Pad van de worktree. |
| `--basis <ref>` | Basis van de wachtrij en van de poort (`--base`), standaard `origin/main`; de body noemt deze basis. De integratie-PR zelf gaat altijd naar `main`. |

## Hooks en `lead status`

`scripts/lead/hooks/` houdt per Claude-sessie en per subagent een register bij, zodat de lead de toestand van haar sessies ziet zonder ListAgents of `tmux capture-pane`. Dit is los van `status.sh` van tmux-pwa (per pane, voor de PWA).

**Identiteit.** Alleen sessies met `LAB_AGENT_ROL` (`lead`, `agent`, `sublead`, `vervolg`) doen mee; zonder rol stopt `hook.sh` meteen met exit 0 (gw-sessies en losse sessies van Brian). `spawn.sh` zet de rol, `LAB_AGENT_NAAM`, `LAB_LEAD_NAAM` en `LAB_OPDRACHT`.

**Startregel van de lead.** De lead krijgt `LAB_AGENT_ROL=lead` pas na een herstart met:

```sh
LAB_LEAD=1 LAB_AGENT_ROL=lead LAB_AGENT_NAAM=lead-<onderwerp> LAB_LEAD_NAAM=lead-<onderwerp> claude -n lead-<onderwerp>
```

Bij elke start van een lead (hook H1) krijgt de lead haar naam voor `SendMessage` terug in de context, alleen bij een verse start (niet bij resume, clear of compact), met de vraag aan Brian om `/rename <naam>` te typen (een model kan dat zelf niet) als `ListAgents` haar onder een andere naam toont (bijvoorbeeld `lab-bawuah-33`). Dit is een aanwijzing; de echte oplossing is de `lead`-functie met `-n`. Een lead die zonder `-n` is gestart (gewone `claude`, niet via de `lead`-functie) is anders niet op naam bereikbaar: het register kent de naam, Claude Code pas na `-n` of `/rename`.

Geef elke lead een unieke naam (`lead-<onderwerp>`): de inbox van de lead heet naar haar naam (`inbox/<naam>.jsonl`), agents schrijven naar `inbox/<hun lead>`. Twee leads met dezelfde naam krijgen elkaars meldingen.

**Het register is de bron.** De env geeft alleen de beginwaarde: bij het eerste record nemen de hooks `LAB_AGENT_NAAM` (lead) en `LAB_LEAD_NAAM` (anderen) over. Daarna lezen ze de leadnaam (lead: `naam`) en het meldadres (anderen: `lead`) bij elk event uit het record, ook de wekker en de inbox-lezer. Een `resume` behoudt die waarden. Een subagent meldt aan de lead van zijn ouder.

**Hernoemen in een lopende sessie** (zonder herstart):

```sh
bun scripts/lead/hernoem.ts --sessie <id> --naam lead-<onderwerp> --volgers w1,w2 --droog
bun scripts/lead/hernoem.ts --sessie <id> --naam lead-<onderwerp> --volgers w1,w2
```

Hernoemt het lead-record (id of uniek begin; zie `bun scripts/lead/status.sh --json`) en zet de genoemde levende sessies (op naam of id, niet `weg`) om naar de nieuwe lead, met hun subagent-records. Zonder `--volgers` wordt geen enkele volger omgezet: er wordt nooit geraden welke sessies van wie zijn. Een onbekende of dode volger, of een naam die al bij een levende lead hoort, geeft exit 1 en schrijft niets. Oude meldingen blijven in de inbox van de oude naam: lees die eerst leeg en noem alle volgers in `--volgers` (wie ontbreekt, blijft naar de oude naam melden). De wekker pakt de nieuwe naam pas bij zijn volgende start. Na `/clear` (nieuw session_id) neemt een sessie naam en lead over van het jongste record in dezelfde pane. Doe daarna in de lead zelf `/rename <nieuw>`, anders komt `SendMessage (to: <nieuw>)` niet aan. Agents die nog de oude naam in hun startzin hebben, sturen hun `SendMessage` naar die oude naam: geef de volgers de nieuwe naam door.

**Dubbele naam.** Bij SessionStart van een lead met een naam die een ander levend lead-record (niet `weg`, pane bestaat nog) al draagt, krijgt de lead een waarschuwing in haar context. `spawn.sh` weigert dan.

### Het register

`${LAB_LEAD_STAAT:-~/.local/state/lab-lead}/` (umask 077): `register/<id>.json` (atomair), `inbox/<lead>.jsonl` en `inbox/<lead>.gelezen`. Bewaard wordt naam, rol, lead, opdracht, cwd, pane, toestand, tijden, de naam van de laatste tool en bij een rapport alleen wie de ontvanger was en of "vrij" erin stond. Nooit: prompts, tool-invoer, antwoorden of transcripts.

| Hook | Event | Doet |
|---|---|---|
| H1 | SessionStart (`startup\|resume`) | maakt het record, `bezig` |
| H2 | UserPromptSubmit | `bezig`, beurtteller op nul; bij de lead: ongelezen meldingen als `additionalContext` |
| H3 | PreToolUse (`*`) | `bezig`, laatste tool; in een subagent het record van de subagent |
| H4 | PostToolUse (`SendMessage`) | `SendMessage` aan de eigen lead: rapport binnen, en `vrij` als het bericht dat woord bevat |
| H5 | Notification (`permission_prompt`, `idle_prompt`) | `goedkeuring` of `idle`, met een melding aan de lead |
| H6 | Stop (agent, sublead, vervolg) | de gate, zie onder; anders `klaar`, `vrij` of `idle`, met een melding |
| H7 | Stop (lead) | ongelezen meldingen: eenmalig `decision: block` met de regels |
| H8 | StopFailure | `vastgelopen`, met een melding |
| H9 | SubagentStart, SubagentStop | record per subagent onder de ouder: `bezig`, daarna `klaar` |
| H10 | SessionEnd | `weg` (één write, timeout 1 s) |
| H11 | Stop met `hook.sh wekker`, alleen met `--met-wekker` | wekt de lead (`asyncRewake`, exit 2) als er een melding komt; geeft op na 30 min |

### Toestanden

`bezig`, `idle`, `goedkeuring` (wacht op een permissieprompt), `klaar` (rapport binnen), `vrij` (rapport met "vrij": nieuwe opdracht of sluiten), `vastgelopen` en `weg`. `klaar` zonder `vrij` betekent dat de afronding (opruimen, "vrij" melden) nog openstaat. `status.sh` voegt `bezig ?` toe (afgeleid, geen hook): geen tool-event in 20 min, of `goedkeuring` langer dan 10 min.

```sh
scripts/lead/status.sh [--lead <n>] [--alles] [--git] [--json]
```

`--alles` toont ook `weg` en afgeronde subagents (`weg` ouder dan 24 uur wordt opgeruimd); `--git` toont per cwd schoon/vuil, tak en of die in `origin/main` zit (laatste fetch, geen netwerk). Subagents van een sub-lead staan onder haar.

### De gate (H6)

Een agent die na minstens één tool stopt zonder `SendMessage` aan de lead krijgt `{"decision":"block","reason":"Je stopt zonder rapport aan <lead>. …"}`. Rem: hoogstens 3 blokkades per sessie, daarna altijd doorlaten met de melding "stopte 3× zonder rapport". Geen blokkade bij `stop_hook_active` (de tweede stop gaat door), zonder tools in de beurt, of zolang er een subagent van de sessie bezig is.

### Meldingen

Elke toestandswijziging die de lead moet weten (klaar, vrij, goedkeuring, vastgelopen, 3× zonder rapport) komt als regel in `inbox/<lead>.jsonl`. De lead krijgt ze bij haar volgende prompt (H2) en bij haar Stop (H7), of via de wekker (H11). Pollen is niet nodig.

### Installeren (Brian draait dit zelf)

```sh
! bun scripts/lead/installeer-hooks.ts --droog      # toont de diff van .hooks en de te kopiëren bestanden
! bun scripts/lead/installeer-hooks.ts              # installeert
! bun scripts/lead/installeer-hooks.ts --verwijder  # haalt precies de eigen entries weg
```

Opties: `--met-wekker` (extra Stop-entry, `asyncRewake`, timeout 1900 s), `--settings <pad>` (standaard `~/.claude/settings.json`), `--doel <map>` (standaard `~/.claude/hooks/lab-lead-hooks/`; moet op `lab-lead-hooks` eindigen). De installer raakt alleen `.hooks` aan; eigen entries herkent hij aan `lab-lead-hooks/hook.sh` in het commando, dus herhaald installeren verandert niets en bestaande entries (tmux-pwa, grenzen, werknotities) blijven gelijk. Hij kopieert `hook.sh`, `hook.ts` en `register.ts` naar het doel (los van de checkout), zet een stabiel bun-pad in het commando (`LAB_LEAD_BUN=<pad> <doel>/hook.sh`; `bun` uit PATH, bv. `/opt/homebrew/bin/bun`, alleen als laatste terugval het versiepad van het proces; `hook.sh` valt zelf terug op `command -v bun` als dat pad niet meer bestaat), maakt eerst een backup `settings.json.voor-lead-hooks-<stempel>`, schrijft atomair en valideert de JSON na het schrijven. Timeouts: 5 s per entry, SessionEnd 1 s. Nieuwe sessies pakken de hooks op; draaiende sessies pas na een herstart.

`bash scripts/lead/hooks/demo.sh` toont alles in een wegwerpomgeving (tijdelijke `HOME`, `CLAUDE_CONFIG_DIR` en staatmap, nep-hook-JSON, installer alleen met `--droog`) en ruimt zichzelf op.

## CI-team

`TURBO_TEAM` in `.github/workflows/ci.yml` moet gelijk zijn aan `remoteCache.teamSlug` in `turbo.json`. De workflow heeft de slug als terugval (`${{ vars.TURBO_TEAM || '<slug>' }}`); `scripts/ci-turbo-team.test.ts` (draait in de poortstap `scripts-tests`) leest beide bestanden (`Bun.YAML`, `Bun.JSONC`) en faalt als ze uiteenlopen.

## Tests

```sh
bun test scripts/lead
```

De tests zetten een nep-`gh` en nep-`tmux` vooraan op `PATH` en gebruiken een wegwerp-git-repo met een lokale bare `origin`. Ze raken nooit de echte tmux-server, GitHub of een echte PR.

## hooks/grenzen.sh

De bron van de PreToolUse-hook `grenzen.sh` (sleutels, uitrolscripts, pkill/killall, stiltevenster, rauwe merge via gh) staat nu in de repo, met tests in `hooks/grenzen.test.ts`. De strenge oude check blijft op het hele commando draaien. Eén bewerking gaat eraan vooraf: de waarde van `-m`/`--message` bij `git commit`/`git tag`, `--title`/`--body` bij `gh pr create|edit|comment` en `gh issue`, en `--title`/`--description`/`--message` bij `glab mr create|update|note` wordt leeggemaakt, maar alleen als het één goed afgesloten quote zonder `$(` of backtick is. Daardoor kan de hook niets doorlaten wat de oude weigerde, behalve tekst in die berichtargumenten (de eigenschapstest bewaakt dat tegen `hooks/fixtures/grenzen-oud.sh`). Brian installeert de hook met `cp scripts/lead/hooks/grenzen.sh ~/.claude/hooks/grenzen.sh`; agents raken `~/.claude` niet aan.
