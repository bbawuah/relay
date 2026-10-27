# Lead-scripts

Scripts voor de lead: een sessie starten met een opdrachtbestand, een PR mergen zonder de voorwaarden te vergeten, een merge-wachtrij die meerdere goedgekeurde PR's als één integratie-PR door de poort haalt, een tak pushen of een gemergede remote tak verwijderen (`push.sh`), en het lab alleen lezen (`lab-lees.sh`). Alle kennen `--droog` (laat zien wat er zou gebeuren, doet niets).

## Ingang: `bun lab help`

Alle scripts van de repo, ook deze, zijn te starten met `bun lab <commando> [args…]` (`scripts/lab.ts`). `bun lab help` toont de commando's per groep; `bun lab help <commando>` toont het pad en, als het script die kent, zijn `--help`. Argumenten, werkmap en exitcode gaan ongewijzigd door. `bun lab merge` neemt de vaste kopie `/usr/local/lib/lab-lead/merge.sh` als die er is.

## Vangnet, geen grens

Deze scripts en `hooks/grenzen.sh` vangen vergissingen van agents op; ze zijn geen grens. Een agent die het bewust wil, komt er langs: hij draait onder dezelfde macOS-gebruiker als Brian, kan bestanden in de repo en zijn eigen omgeving wijzigen en heeft dezelfde `gh`-, git- en ssh-toegang. Wat de grens echt maakt, is architectuur (nog niet gebouwd):

- **een eigen macOS-gebruiker voor agents, of managed settings** van Claude Code die een agent niet kan wijzigen (nu kan een agent met schrijfrecht op zijn eigen home de hook en de allow-regels in principe aanpassen);
- **een verplichte review in de ruleset** (of een CODEOWNERS met de lead): nu vraagt de ruleset 0 reviews, dus wie `gh` heeft, kan mergen zodra de poort groen is;
- **een read-only lab-account** met een smalle rol aan de lab-kant (geen secrets, geen configmaps), in plaats van het eigen account achter `ssh jump`;
- **`ForceCommand` op de jump** voor dat account, zodat daar alleen de alleen-lezen `oc`-aanroepen kunnen draaien, wat er aan de mini-kant ook gebeurt.

Tot die tijd krijgt alleen `merge.sh` een allow-regel, op de root-kopie `/usr/local/lib/lab-lead/merge.sh` (zie `installeer-grens.ts`), niet op de repo. `push.sh` en `lab-lees.sh` krijgen geen allow-regel: ze zijn de aanbevolen route (de hook verwijst ernaar), maar elke aanroep gaat nog langs de veiligheidscheck van Claude Code.

## spawn.sh

Start `claude` in een nieuw tmux-venster via `~/.claude/tmux/agent-spawn.sh`, wacht tot de sessie invoer aanneemt, typt de vaste startzin en controleert dat de sessie aan het werk gaat.

```sh
scripts/lead/spawn.sh --naam w2 --opdracht ~/vault-b-status/werkwijze-b/CONTRACT.md \
  --model sonnet --map ~/Desktop/LAB-BAWUAH/lab-bawuah/.claude/worktrees/w2 --lead labbawuah-1c
scripts/lead/spawn.sh --naam w2 --opdracht opdracht.md --lead labbawuah-1c --droog
```

Veel sessies tegelijk: `spawn.sh --meerdere lijst.txt --lead <n> [--model ..] [--map ..]`, met per regel `naam opdrachtbestand [sonnet|opus]`. Alle sessies starten parallel (een lus van tien liep tegen de time-out van 600 s en de laatste kreeg zijn startregel niet). De hele lijst wordt eerst gevalideerd (dubbele naam, kapotte regel, ontbrekend opdrachtbestand, ongeldig model): bij een fout start er niets. Het eindoordeel is luid: exit 1 en per mislukte sessie een regel `MISLUKT <naam>` met de reden, bijvoorbeeld "geen tool-aanroep" als de startregel niet aankwam.

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
| `--t3` | Start de sessie als thread in T3 Code in plaats van in tmux; `--map` moet een eigen worktree zijn. Zie "`--t3`" hieronder. |
| `--vendor claude\|codex` | Standaard `claude`. `codex` start `codex -C <map>` (met `--model` als Codex-model, `-m`), zie "`--vendor codex`" hieronder. Sluit `--sublead` uit. |
| `--droog` | Alleen tonen. |

Wat het doet:

1. Start `agent-spawn.sh window <map> "env LAB_AGENT_NAAM=<naam> LAB_AGENT_ROL=<agent|sublead|vervolg> LAB_LEAD_NAAM=<lead> LAB_OPDRACHT=<abs pad> claude -n <naam> [--model m]"`. Het voorvoegsel is de identiteit voor de hooks (zie "Hooks en `lead status`"); het opdrachtpad staat in het voorvoegsel (met spatie tussen enkele quotes), de startzin staat niet in de quotes van het commando. Direct na het starten zet het script `tmux set -p -t <pane> @agent_rol <rol>` en `@agent_naam <naam>`.
2. Wacht (max 60 s) tot `tmux capture-pane` "auto mode" of een lege invoerbox (`│ ❯`) toont. Toont de pane de vertrouwensvraag van Claude Code (de tekst "Quick safety check" / "Yes, I trust this folder"; andere vragen tellen niet), dan wacht het script: één melding aan Brian (`tmux display-message` op alle clients plus op stderr: "<naam> wacht op vertrouwen in pane %N (map <map>)"), daarna pollen tot de vraag weg is, max `WACHT_VERTROUWEN` seconden (standaard 600, env). Daarna gaat het door met de prompt-controle en de startzin. Het script beantwoordt de vraag nooit zelf (geen toets). Loopt de tijd af, dan exit 1 met pane, map en de startzin om met de hand te typen. Vooraf leest het (alleen lezen, jq) `.projects[<map of bovenliggende map>].hasTrustDialogAccepted` in `~/.claude.json` (env `LAB_CLAUDE_JSON` voor tests) en waarschuwt op stderr als de map niet vertrouwd is; er wordt nooit in dat bestand geschreven.
3. Typt met `tmux send-keys -l` de startzin: "Je lead is <lead>. Jij bent sessie <naam>. Lees <bestand> en voer die uit. Rapporteer aan de lead via SendMessage (to: <lead>)." en daarna Enter.
4. Wacht (max 30 s) op een tool-aanroep (`⏺`) in de pane. Zo niet: exit 1 met melding.
5. Print het pane-id (bijvoorbeeld `%12`) op stdout.

Het script moet binnen tmux draaien (dat eist `agent-spawn.sh`). Voor tests kunnen de wachttijden en het spawn-script worden overschreven: `LAB_SPAWN_SCRIPT`, `LAB_SPAWN_WACHT`, `LAB_SPAWN_POLS`, `LAB_SPAWN_BEWIJS`, `LAB_SPAWN_ENTER` (seconden tussen startzin en Enter bij Codex, standaard 1: Codex ziet snel typen + Enter als plakken en maakt van Enter dan een nieuwe regel) (hele getallen) en `LAB_PEERS_SERVER` (pad van de peers-MCP voor `--vendor codex`). `bun test scripts/lead/spawn-vertrouwen.test.ts` toetst het wachten met een echte tmux op een wegwerp-socket (`spawntest-<pid>`) en een nep-spawnscript.

### `--vendor codex`: een Codex-werker

`spawn.sh --vendor codex ...` start Codex in plaats van Claude, in tmux of (met `--t3`) als Codex-thread in T3 Code (`--provider codex`). Verschillen met Claude:

- **Omgeving.** `LAB_AGENT_NAAM`, `LAB_AGENT_ROL` (altijd gezet; `grenzen.sh` past zijn rolregels, zoals de hoofdcheckout-regel, alleen toe met een rol), `LAB_LEAD_NAAM`, `LAB_OPDRACHT`, `LAB_SPAWN_ID` (en `LAB_LEAD_STAAT` als gezet) staan in het `env`-voorvoegsel. Dat bereikt de TUI, **niet** de hooks: de Codex-TUI praat met een app-server-daemon die per `CODEX_HOME` gedeeld wordt, en hooks en MCP-servers erven de omgeving van die daemon, niet die van de pane. Daarom schrijft spawn ook `<staat>/identiteit/<sha256(echt pad van de checkout)[:24]>.json` (modus 0600 in een map 0700, met `ts`; geldig 12 u, `SessionEnd` van dezelfde spawn wist het). `hooks/codex-wrap.sh` (de Codex-hookcommando's) zoekt dat bestand vanaf de `cwd` van de hook omhoog en zet er `LAB_AGENT_*`, `LAB_LEAD_NAAM`, `LAB_OPDRACHT`, `LAB_SPAWN_ID` en `LAB_T3_THREAD` mee over de omgeving van `hook.sh` en `grenzen.sh`; zonder bestand haalt hij die sleutels juist uit de omgeving (de daemon-omgeving is van een andere sessie). Het bestand telt alleen met een rol `agent`, `sublead` of `vervolg` (nooit `lead`), als gewoon bestand van de eigen gebruiker met modus 0600 in een map 0700, en een lange sessie ververst `ts` bij elke prompt en stop. **Iedereen met dezelfde cwd krijgt die identiteit**; daarom alleen voor een eigen worktree: `--map` met `git-dir == git-common-dir` (de hoofdcheckout of een map zonder eigen worktree) wordt in tmux én T3 geweigerd, één Codex-sessie per checkout (een tweede met een andere naam wordt geweigerd; dezelfde naam pas opnieuw als de vorige spawn in het register `weg` is), en een sessie in een andere checkout heeft geen bestand en dus geen identiteit. Start de sessie niet, dan haalt spawn het bestand weer weg.
- **peers-MCP.** In tmux gaat de MCP-server per spawn mee als `-c mcp_servers.peers.*` met een statische `env`-tabel (naam, lead, staat), nooit in `~/.codex/config.toml`. Een T3-thread kan geen `-c` per thread krijgen: de server leest daar de identiteit uit `<staat>/identiteit` (volgt in de MCP-PR). Zonder `peers/server.ts` start de sessie met een waarschuwing zonder `peers.send`. Een `-c`-override zet Codex in embedded mode ("Running without the shared background server", een waarschuwing in de TUI): dan erven de hooks wél de omgeving van de pane; zonder `-c` (geen MCP) of in T3 draait de gedeelde daemon en is het identiteitsbestand de enige route.
- **Rapport.** Codex kent geen `SendMessage`: de startzin vraagt om de tool `send` van MCP-server `peers` (`naar: <lead>`).
- **Klaar-detectie.** In tmux wacht spawn op `Ask Codex` of een lege `›`-regel, meldt (en beantwoordt nooit) de Codex-vertrouwensvraag (`Hooks need review`), en zoekt als bewijs een `•`-regel in plaats van `⏺`.
- **Grenzen-hook (verplicht).** `spawn.sh --vendor codex` weigert (ook met `--droog`) te starten zolang `${CODEX_HOME:-~/.codex}/config.toml` geen PreToolUse-groep voor `grenzen.sh` heeft (geankerde matcher die `Bash` en `apply_patch` dekt, commando exact dat van `codex-installeer.ts`, wrapper/`grenzen.sh`/bun aanwezig en uitvoerbaar) mét een geldige `trusted_hash` in `hooks.state` (`hooks/codex-controle.ts`). Zonder die hook gelden de rolregels van spoor E niet. De controle is statisch: de hash dekt de hookdefinitie, niet de inhoud van de bestanden, dus spawn weigert ook als de geïnstalleerde `grenzen.sh`, `codex-wrap.*` of `register.ts` afwijkt van de repo ("draai codex-installeer opnieuw", na elke `git pull` die die bestanden raakt). Of de hash nog klopt met het blok ziet alleen Codex (`modified`); wijzig je het blok met de hand, draai dan `codex-installeer.ts` opnieuw. In tmux krijgt de pane `CODEX_HOME=<gecontroleerd pad>` mee (de pane erft anders de omgeving van de tmux-server); een T3-thread draait onder T3's eigen `CODEX_HOME`. Een commando dat ontbreekt of niet uitvoerbaar is, weigert bij PreToolUse met exit 2 (exit 1 telt in Codex als niet-blokkerend).
- **Hook-trust (Brian, eenmalig).** Codex draait hooks pas na trust per hook-hash. `bun scripts/lead/hooks/codex-installeer.ts --droog` toont wat er in `~/.codex/config.toml` komt (hook-regels plus `trusted_hash` via `codex app-server`); zonder `--droog` schrijft het, idempotent, met een backup `config.toml.voor-peerbus`. Eerst `bun scripts/lead/installeer-hooks.ts` opnieuw draaien: de gekopieerde hooks krijgen nu ook `codex-adapter.ts`, `codex-wrap.*`, de nieuwe PostToolUse-matcher en de SessionStart-matcher `startup|clear|resume`. De installer kiest een stabiel `bun`-pad uit `PATH` (niet het versiepad van het draaiende proces).
- **Hooks naar de bus.** `hook.ts` laadt de peerbus (`peers/`; geïnstalleerd onder `<doel>/peers` en `<doel>/hooks/register.ts`, fail-open als hij ontbreekt). `UserPromptSubmit` geeft het aantal ongelezen berichten als `seintje(n)` (alleen het aantal, nooit de inhoud) in `additionalContext`; `Stop` blokkeert met dat seintje alleen als het aantal ongelezen gestegen is sinds het laatste seintje (`seintje_n` in het record; het seintje van `UserPromptSubmit` telt als gezien) en nooit bij `stop_hook_active` (gemeten op Codex 0.164.0 met een probe-hook: de eerste Stop heeft `false`, de Stop na een block `true`; het staat niet in een fixture, die toont alleen `false`); `Stop` en `SessionEnd` roepen `bus.idleGemeld(naam, toestand)` aan, zodat `notify_when_idle` afgaat, met een tijdsgrens (1 s bij Stop, 0,5 s bij SessionEnd): wacht de bus langer in zijn wekvenster, dan komt de hook terug en neemt een volgende `list()` de wek over. De telling gaat met `bus.ongelezen(naam)` (alleen lezen), niet met `list()`. De hooks roepen `standaardBus().klaar()` niet aan (dat laat een timer van 15 s hangen). `hook.ts` zoekt de bus eerst op `./peers` (de installatiemap), dan op `../peers` (de repo); na een `git pull` die `peers/*.ts` raakt is een herinstallatie nodig (`installeer-hooks.ts` en `codex-installeer.ts`).
- **Rapport en herkomst (grenzen).** Alleen een `mcp__peers__send` die lukt (niet `niet verstuurd` of `vastgehouden`) telt als rapport voor de Stop-gate. De MCP-vorm van `tool_response` is in Codex niet gemeten; ontbreekt hij of is hij onbekend, dan telt de send. Hosted web search is uit voor werkers: tmux start met `-c 'web_search="disabled"'` (geen `--search`; gemeten op codex-cli 0.164.0: de tool verdwijnt uit het verzoek) en `spawn.sh --t3` weigert als de `config.toml` van het doel hem aanzet (`web_search = "live"|"cached"`, `tools.web_search`, `features.web_search_request|web_search_cached`), met de melding wat te zetten. De T3-controle is een allowlist (alleen geen sleutel of `"disabled"`; elke andere waarde weigert) en kijkt ook naar `<worktree>/.codex/config.toml`. Gemeten: `-c web_search="disabled"` wint van zo'n project-config (tmux is dus veilig), een `profile = …` in config.toml geeft een fout in 0.164.0 (een profiel gaat alleen met `--profile`, wat spawn nooit meegeeft). Niet gedekt: een `--search` of `-p` door Brian zelf, een beheerde requirements.toml, en een model dat hem standaard aanbiedt zonder dat de config iets zegt (bij de modellen van de bundelcatalogus biedt Codex hem niet aan). Bekend gat: `write_stdin` (het bijbehorende `unified_exec`) is geen hook-event: een genest `tools.write_stdin` in het code-mode-`exec` van de huidige modellen riep geen enkele PreToolUse aan (gemeten), terwijl `exec_command` er wel een geeft (en grenzen.sh blokkeert dan gewoon). Dus tekst die naar een al lopend proces gaat (een door `exec_command` gestarte shell) gaat niet langs `grenzen.sh`. Er is geen config-sleutel gevonden die dit uitzet: `features.unified_exec=false` en `--disable unified_exec` veranderen de toolset niet, `features.shell_tool=false` haalt `write_stdin` weg maar ook de shell, en een `shell_type`-override via `model_catalog_json` deed niets. Brian heeft dit gat geaccepteerd (het gaat niet naar OpenAI); de sandbox hieronder beperkt wat een `write_stdin` kan schrijven.

**Sandbox van een Codex-werker (tmux).** `spawn.sh --vendor codex` start `codex -a never` met een permissieprofiel (`-c default_permissions="lab-werker"`, `-c 'permissions.lab-werker.filesystem={…}'`, `-c 'permissions.lab-werker.network={enabled=true}'`): alles leesbaar (`"/"="read"`), schrijven alleen in de worktree, `/tmp`, `$TMPDIR`, `~/.bun/install/cache` en in de gedeelde `.git` alleen `objects`, `refs`, `logs` en `worktrees/<naam>`; daarbinnen blijven `commondir`, `gitdir` en `config.worktree` read-only. `.git/hooks` en `.git/config` zijn dus niet schrijfbaar (EPERM, ook niet via `write_stdin`), en `.git` van de worktree zelf ook niet. Onleesbaar: `~/.config/klaarover|douane|agentwerkbank` en `~/.codex/auth.json`. Netwerk staat aan (push, `gh`). `-a never`: geen verzoek om buiten de sandbox te draaien (er is niemand in de pane; een goedkeuring zou de sandbox opheffen). Waarom een profiel en niet `--sandbox workspace-write` met `sandbox_workspace_write.writable_roots`: gemeten dat `worktrees/<naam>` als root `commondir` en `gitdir` schrijfbaar maakt, waarmee een git in die worktree naar een andere common dir (en dus andere hooks en config) gestuurd kan worden; een profiel met `read` op die bestanden houdt ze dicht (test met een echte codex in `lead.test.ts`, macOS, EPERM via de shell). Gevolgen: andere schrijfacties naar `.git/config` mislukken, dus ook `git push -u`: spawn zet daarom vooraf (buiten de sandbox) `branch.<tak>.remote=origin` en `branch.<tak>.merge=refs/heads/<tak>` (alleen als de tak nog geen upstream heeft of die naar main/master wijst; niet bij een losse HEAD, main/master of zonder remote `origin`), zodat een gewone `git push` werkt; push anders met `git push origin <tak>`, zonder `-u`; een commit geeft een waarschuwing over `packed-refs.lock` maar slaagt; de poort schrijft zijn log niet naar `<git-common-dir>/lab-poort` (waarschuwing, de poort gaat door); `bun install` buiten de bun-cache of schrijven naar `~/.cache` mislukt. T3 kan dit niet per thread (geen `-c`): `--t3 --vendor codex` weigert tenzij `--zonder-sandbox` (dan draait de thread met de sandbox van T3 zelf). **`--zonder-sandbox` is een expliciete escape en mag alleen op aanwijzing van Brian**; de weigering zegt dat ook. Niet getoetst: Linux/landlock, en of T3 een `default_permissions` uit de config.toml volgt. Bij `resume` blijft de herkomst `extern`; `startup` en `clear` maken schoon.

**Wat de sandbox niet is.** Hij beschermt tegen ongelukken en tegen een werker die per ongeluk of door een prompt-injectie buiten zijn worktree schrijft, niet tegen een kwaadwillende werker: die draait onder dezelfde uid als Brian en de lead. Bekende omwegen, gemeten of beredeneerd:
- **Unix-sockets** (gemeten op codex-cli 0.164.0, macOS, echte codex + nep-Responses-server, wegwerp-tmux via `-S` en een eigen stand-in-socket met `nc -U` en python): zolang `network.enabled=true` staat, kan een commando in de sandbox met elke unix-socket verbinden. `tmux -S <socket> send-keys -t s 'touch <buiten>/X' Enter` laat de pane (buiten de sandbox) het commando uitvoeren; `new-window` en `run-shell` werken naar verwachting net zo (niet apart gemeten), en dat geldt ook voor andere sockets van Brian (`/tmp/cc-socks/*.sock`: een bericht in een Claude-sessie; gemeten alleen met een stand-in-socket, niet met een echte sessie). Geen sleutel in het profiel helpt: `allow_unix_sockets=[]` geeft geen foutmelding en geen effect, `unix_sockets={"<pad>"="deny"}`, `dangerously_allow_all_unix_sockets=false`, `domains`, `proxy_url`, `allow_local_binding=false` en `mode="limited"` veranderden niets (`unix_sockets={"<pad>"="none"}` is een configfout: alleen `allow` of `deny`). Alleen `network.enabled=false` blokkeert de verbinding (EPERM), maar dan is er ook geen netwerk voor `git push`, `gh` en `bun install` (zo bedoeld, niet apart gemeten). Keuze voor Brian: netwerk uit (geen push of gh in de werker) of netwerk aan en deze omweg accepteren.
- `git update-ref` en andere schrijfacties op `refs/` van andere takken (de gedeelde `refs/` is schrijfbaar, nodig voor commit en push).
- De fsmonitor/submodule-route: git in de lead-tooling (status.ts, wachtrij.ts, opruimen) draait buiten de sandbox en leest `.git/config` en de worktree; een werker kan in zijn worktree een `core.fsmonitor`, hook of submodule-pad zetten waarmee dat git code uitvoert. Het harden van die aanroepen (`-c core.fsmonitor= -c core.hooksPath=/dev/null --ignore-submodules=all`) is een aparte wijziging.
- `peers/server.ts` zonder identiteitsbestand houdt de geërfde `LAB_AGENT_NAAM`: wie dat bestand niet heeft, kan zich voordoen als de naam die zijn omgeving noemt (routering, geen authenticatie).


### `--t3`: sessie als thread in T3 Code

`spawn.sh --t3 --naam <n> --opdracht <bestand> --map <eigen worktree> [--model ..] [--lead ..]` start de sessie niet in tmux maar als thread in T3 Code (de server die de T3-desktop-app via SSH op deze machine draait). Brian ziet de thread dan in de app op de laptop, met diff-review en checkpoints. Werkt ook met `--sublead`, `--vervolg`, `--meerdere` en `--droog`.

1. **Map.** `--map` moet de wortel van een eigen linked worktree zijn: niet de hoofdcheckout, geen submap, en `.claude/settings.local.json` moet daar git-genegeerd zijn. Anders exit 1 en er wordt niets geschreven.
2. **Identiteit.** T3 kent geen omgeving per thread, alleen per provider-instantie. Daarom zet het script `LAB_AGENT_NAAM`, `LAB_AGENT_ROL`, `LAB_LEAD_NAAM`, `LAB_OPDRACHT` en `LAB_SPAWN_ID` in `env` van `<map>/.claude/settings.local.json` (met jq; andere sleutels blijven staan). De Claude-provider van T3 leest dat bestand per checkout, dus de hooks (`grenzen.sh`, register, pre-push) zien de sessie als agent. Gevolg: één T3-sessie per checkout. Draagt het bestand al een andere `LAB_AGENT_NAAM`, dan weigert het script. Haal na afloop de `LAB_*`-sleutels weg als je de worktree hergebruikt; elke andere Claude-sessie in die map krijgt de identiteit ook.
3. **Project en thread.** Is de map nog geen T3-project (`t3 thread list` in de map faalt), dan `t3 project add --title <naam> <map>`. Daarna `t3 thread start --title <naam> --provider claudeAgent --model <slug> <map> -` met de startzin op stdin. Model: `sonnet` geeft `claude-sonnet-5-5`, `opus` geeft `claude-opus-5-5`, zonder `--model` geldt `LAB_T3_MODEL` (standaard `claude-opus-5-5`). Provider: `LAB_T3_PROVIDER` (standaard `claudeAgent`).
4. **Startzin.** Dezelfde als in tmux, plus: geen `AskUserQuestion` (vraag in tekst) en het laatste rapport ook als laatste antwoord in de thread.
5. **Bewijs.** Pollt `t3 thread show <id> --json` (max `LAB_SPAWN_BEWIJS` s) tot de thread minstens 3 items heeft. Item 1 is de startzin, item 2 een command_execution die binnen milliseconden meedraait (vermoedelijk een hook), item 3 is het eerste werk van de agent. Een status `failed`, `error`, `interrupted` of `cancelled` geeft exit 1.
6. **Uitvoer.** De laatste regel is `t3:<thread-id>`, ook in `--meerdere`.

De `t3`-binary staat niet op `PATH`: het script neemt `LAB_T3`, anders `t3` op `PATH`, anders de nieuwste `~/.t3/runtime/versions/*/t3`.

Wat de lead moet weten (proef 25 okt 2026, T3 0.1.2):

- **Rapport lezen.** Een SendMessage van een T3-thread naar de lead kwam in de proef aan, maar pas na een tijd vastgehouden te zijn, en alleen met de volle sessienaam van de lead (de korte referentie `[xxxxxx]` werkte niet). Niet getoetst: een lead in tmux met een gewone naam. Het rapport staat altijd als laatste antwoord in de thread: `t3 thread show <id> --messages 1`. T3-threads staan in `ListAgents` als `<mapnaam>-<xx>`, niet onder `--naam`.
- **Nooit sturen bij een open vraag.** `t3 thread send` naar een thread met `pendingRequestCount > 0` laat die vraag vastlopen (T3-issue #15517). Het script waarschuwt op stderr als de thread direct een vraag stelt. Naar een bezige thread sturen mag: het bericht komt als volgende beurt (`Queued.`).
- **Stoppen of een vraag beantwoorden** kan alleen in de app; daar is geen CLI voor.
- **Rechten.** Threads draaien in de standaardmodus van het project (nu Full access). De hooks gelden ook dan.

## merge.sh

```sh
scripts/lead/merge.sh 71 --droog   # controleren
scripts/lead/merge.sh 71           # mergen
```

Weigert met exit 1 en een duidelijke reden als:

- `LAB_AGENT_ROL` niet `lead` is ("merge: geweigerd: alleen de lead merget (LAB_AGENT_ROL=lead)"): een gespawnde agent kan zelf een akkoord-comment posten, maar niet mergen. `--droog` mag zonder die rol. De lead krijgt de rol door te starten met `lead <onderwerp>` (zie "Startregel van de lead"); een prefix `LAB_AGENT_ROL=lead scripts/lead/merge.sh …` valt buiten de allow-regel en gaat dus langs de veiligheidscheck;
- de PR niet OPEN is;
- de PR uit een fork komt (`isCrossRepository`) of de tak `main`/`master` is;
- er geen PR-comment is die begint met "Lead-review: akkoord <sha7>", met de eerste 7 tekens van de huidige head. Een akkoord van vóór een nieuwe push telt dus niet ("push na akkoord"). Voorbeeld: `Lead-review: akkoord b80ed00`;
- de PR geen enkele CheckRun van workflow `CI` heeft (de Vercel-entries in de rollup tellen niet mee; GitHub startte soms geen CI bij een nieuwe PR: #85, #87, #88): de melding is `geen CI-run voor <sha7>; sluit en heropen de PR of push opnieuw`, geen "niet groen" en geen wachten;
- de verplichte check `poort` ontbreekt of niet groen is (de nieuwste run op starttijd telt; andere checks niet);
- `mergeable` niet `MERGEABLE` is, of de tak achterloopt op main (`BEHIND`, de ruleset is strict), of `mergeStateStatus` iets anders is dan CLEAN of UNSTABLE (allowlist). Bij UNSTABLE volgt een waarschuwing;
- er geen geldige **e2e-stempel** is: geen merge zonder een groene volledige poort (met de geraakte e2e) op de patch van de PR. `scripts/poort.ts` schrijft na een groene volledige run op een schone werkkopie `~/.cache/lab-bawuah/poort/<sha>.json` (`{sha, groen: true, modus, base, tijd}`). merge.sh zoekt een stempel op de head en daarna op de commits van de PR (nieuw naar oud), en eist:
  - `groen: true`, `sha` gelijk aan de bestandsnaam, `modus` `alles`, of `affected` met een `base` die een voorouder is van de merge-base van main en die commit (een poort met `--base HEAD` telt dus niet). Een symlink telt niet;
  - bij een stempel op een oudere commit S: dezelfde eigen patch, `git patch-id --stable` van `main...S` gelijk aan die van `main...head`, via `gh api …/compare` (geen fetch, geen repo-code). Zo maakt `update-branch` de stempel niet ongeldig. De combinatie met de nieuwere main toetst dit niet; die is voor een volledige e2e na de merge (plan wf-pijplijn, nog niet gebouwd). Wijzigde main context rond de hunks van de PR, dan verschilt de patch-id en weigert merge.sh (draai dan de poort op de head).

  De melding zegt wat ontbreekt (geen stempel, niet groen of oud formaat, verkeerde basis, patch gewijzigd); `gh api` die faalt is een weigering. Vangnet, geen grens: een agent kan het stempelbestand zelf schrijven, tot de e2e buiten de agent draait en de stempel schrijft waar agents niet bij kunnen. `LAB_MERGE_STEMPELS` (andere stempelmap, voor de tests) geldt niet in de root-kopie.

Zijn de voorwaarden in orde, dan: de merge met `--merge --match-head-commit <volledige head-sha>` (de head die net tegen het akkoord is getoetst; verschuift de head tussen controle en merge, dan weigert GitHub), daarna controleren dat `state` `MERGED` is, en pas dan de remote tak weg via de API (`gh api -X DELETE repos/<GH_REPO>/git/refs/heads/<tak>`, dus niet via git en de pre-push-hook). Staat de PR niet op MERGED, dan blijft de remote tak staan en eindigt het script met exit 1.

### Bezitscheck (optioneel)

```sh
scripts/lead/merge.sh 71 --droog --contract ~/vault-b-status/werkwijze-b/CONTRACT-fase3.md --spoor D2
```

Leest de regel `Bezit: …` in de sectie `## <spoor> ·` van het contract, haalt de paden uit de stukken tussen backticks (een stuk telt als pad als het een `/` of `.` bevat; `scripts/lead/*.test.ts` is een patroon, `docs/` een map, een kaal `merge.sh` telt als bestandsnaam in welke map dan ook) en vergelijkt ze met de bestanden van de PR. Bestanden buiten het Bezit komen als waarschuwing op stderr; het mergen gaat door, de lead beslist. Zonder `--contract` en `--spoor` doet merge.sh niets extra's; één van de twee alleen, een onbekend spoor of een contract zonder paden in de Bezit-regel is een weigering.

Het script gebruikt `gh` en `jq` en pusht vanuit de huidige git-map; draai het vanuit een clone van de repo. Elke `gh`-aanroep krijgt `--repo` uit `lead.conf` (`GH_REPO=bbawuah/LAB-BAWUAH`), dus de werkmap kiest de repo niet. `lead.conf` wordt niet ge-sourcet: merge.sh leest alleen de regels `CI_WORKFLOW=` en `GH_REPO=` met een vaste vorm (een regel met code erin wordt nooit uitgevoerd).

merge.sh, push.sh en lab-lees.sh draaien met `#!/bin/bash -p` (geen `BASH_ENV`, die ook nog wordt ge-unset). Als root-kopie in `/usr/local/lib/lab-lead/` zetten ze een vaste `PATH=/usr/bin:/bin:/opt/homebrew/bin`, en merge.sh negeert daar `LAB_MERGE_CHECK` en `LAB_MERGE_CI_WORKFLOW` (die zijn er voor de tests). In de repo blijft `PATH` staan, zodat de tests een nep-`gh` vooraan kunnen zetten.

## installeer-grens.ts

Zodra er een allow-regel op `merge.sh` staat, is dat script het vangnet voor mergen. In de repo of een worktree kan een agent het aanpassen; daarom wijst de allow-regel naar de kopie in `/usr/local/lib/lab-lead/` (root:wheel), niet naar de repo. Alleen `merge.sh` en `lead.conf` (die merge.sh naast zichzelf leest) worden geïnstalleerd; `push.sh` en `lab-lees.sh` blijven in de repo zolang ze geen allow-regel hebben.

```sh
bun scripts/lead/installeer-grens.ts               # print de sudo-commando's; voert zelf niets uit
bun scripts/lead/installeer-grens.ts --controleer  # vergelijk de kopieën met origin/main
```

De verwachte inhoud komt uit `origin/main`, niet uit de werkkopie: het script haalt `main` vers op (`git fetch origin`) en leest de blobs met `git cat-file -p origin/main:scripts/lead/<bestand>`. Zonder opties print het de regels die Brian zelf draait: `sudo install -d -o root -g wheel -m 755 /usr/local/lib/lab-lead` en `sudo install -o root -g wheel -m 755|644 <bron> <doel>` voor `merge.sh` (755) en `lead.conf` (644), plus `shasum -a 256 /usr/local/lib/lab-lead/*` met de verwachte sha256 per bestand. Wijkt de werkkopie af van `origin/main`, dan print het niets en weigert het (exit 1). Het voert nooit sudo uit.

`--controleer` eist:

- het doel is zijn eigen echte pad (`realpath(doel) === doel`, geen symlink in het pad), en elke voorouder tot `/` is van root, geen symlink en niet schrijfbaar voor groep of anderen;
- de doelmap en elk bestand: aanwezig, geen symlink, eigenaar root, niet schrijfbaar voor groep of anderen, geen ACL (`ls -led`), de juiste modus;
- per bestand dezelfde sha256 als de blob in `origin/main`.

Exit 1 met een FOUT-regel per probleem. `--doel`, `--eigenaar <uid>`, `--repo <map>` en `--zonder-fetch` zijn er voor de tests (`installeer-grens.test.ts`: een wegwerp-repo met `refs/remotes/origin/main`, een tijdelijke doelmap met de eigen uid en een nep-`sudo` die nooit wordt aangeroepen). Na elke merge die `merge.sh` of `lead.conf` wijzigt: opnieuw installeren en `--controleer`.

Staat `scripts/lead/commando/runner.ts` in `origin/main`, dan hoort de commando-runner er ook bij:
- de bundel `commando-runner.js` (755). Die wordt gebouwd uit `git archive origin/main` met `bun install --frozen-lockfile --ignore-scripts` en `bun build`, deterministisch bij dezelfde bun en `bun.lock`;
- `passkeys.pub` (644, alleen publieke sleutels; `--controleer` toetst het formaat en toont de sha256 en per sleutel het korte id en het apparaat);
- de LaunchAgent `~/Library/LaunchAgents/nl.lab-b.commando.plist`, die gelijk moet zijn aan het sjabloon.

`--sleutels-export <uit> --login <login> --rpid <host> --origin <url>` leest de passkey-opslag van de tmux-app en draait daarom alleen bij Brian. Het neemt alleen de passkeys van die login mee en print per sleutel naam, datum en kort id, plus de sha256 van het bestand. De stappen staan in `commando/INSTALLEREN.md`. Live draait de runner in fase 1 alleen tailscale met een vast pad; `tak-weg` weigert hij live.

## wachtrij.ts

```sh
bun scripts/lead/wachtrij.ts --droog          # alleen laten zien
bun scripts/lead/wachtrij.ts                  # bouwen, poort draaien, integratie-PR openen
bun scripts/lead/wachtrij.ts --ruim-takken    # na MERGED: remote takken van de onderliggende PR's weg
```

Stappen:

1. Open PR's met een comment die begint met `Lead-review: akkoord <sha7>`, waarbij de sha7 de huidige head is. Forks, concepten en eerdere `wachtrij/`-PR's tellen niet; een verouderd akkoord wordt gemeld.
2. Tak `wachtrij/<jjjjmmdd-hhmm>` in een eigen worktree (naast de repo, `<repo>-wachtrij-<stempel>`) vanaf `origin/main`. De PR's worden in volgorde van nummer samengevoegd met `git merge --no-ff` van de echte head (dus geen squash: GitHub ziet de commits en sluit de onderliggende PR's als gemerged). Een conflict of een tak die na het akkoord is verschoven haalt die PR eruit, met een melding.
3. `bun install --frozen-lockfile && bun run poort --base <basis>` in de worktree (basis standaard `origin/main`): de volledige poort mét e2e. Rood of een poort die bestanden achterlaat = geen push, geen PR. De melding noemt wat er blijft staan (worktree, lokale tak, na een push ook de remote tak) en hoe je het opruimt; hetzelfde na een mislukte push of PR-aanmaak. In het stiltevenster 05:00–07:15 weigert het script (ook `--droog` meldt het). Alle wachtrij-worktrees delen één turbo-cache (`TURBO_CACHE_DIR`, standaard `~/.cache/lab-turbo-wachtrij`, override met env `LAB_WACHTRIJ_TURBO_CACHE`), dus een e2e die niet veranderd is komt uit de cache (zie de e2e-cacheregel in AGENTS.md).
4. Push en één integratie-PR met het sjabloon: Samenvatting (de lijst), Bewijs (`poort: groen (met e2e) op <sha7>: #n, #m` pas na de geslaagde run, plus de `OK bekijk <app>`-regels uit de onderliggende PR's, alleen van een PR die die app echt raakt) en Merge-gevaar (de sectie van de zwaarste onderliggende PR). Titels en Merge-gevaar-tekst uit de onderliggende PR's worden onschadelijk gemaakt (`OK bekijk` wordt `OK-bekijk`, `poort:` wordt `poort -`, marker- en akkoordregels vallen weg), zodat ze geen bewijsregel kunnen nabootsen. Een regel `Wachtrij-PR's: <nr>=<tak>=<sha> …` in de body is voor `--ruim-takken`.
5. **De lead controleert de lijst PR's in de integratie-PR** (ook bij een vaste lijst met `--prs`: wat samengevoegd is, wat eruit viel en waarom), geeft dan op de integratie-PR `Lead-review: akkoord <sha7>` en draait `merge.sh <pr>`.
6. `--ruim-takken [<pr>]` (zonder nummer: de laatste gemergede `wachtrij/`-PR): weigert als de PR niet MERGED is, en verwijdert per onderliggende PR de remote tak alleen als de head in `origin/main` staat én de remote tak nog op die sha staat. Standaard worden de takken dus niet verwijderd.

| Optie | Betekenis |
|---|---|
| `--droog` | Alleen tonen; ook bij `--ruim-takken`. |
| `--prs <n,n,…>` | Vaste lijst, bijvoorbeeld `--prs 81,82`: alleen deze PR's, in deze volgorde. Valt een genoemde PR af (niet open, geen geldig akkoord op de huidige head), dan stopt de wachtrij vóór het samenvoegen met exit 1 en per PR de reden; er komt geen worktree, poortrun of integratie-PR. Ook bij `--droog`. Een PR die pas bij het samenvoegen eruit valt (verschoven tak, mergeconflict) valt nog steeds af met een melding; de lead ziet dat in de lijst van de integratie-PR. |
| `--sla-afgevallen-over` | Alleen met `--prs`: ga toch door zonder de PR's die afvallen (het oude gedrag). De afvallers staan in de integratie-PR. |
| `--poort-cmd <cmd>` | Vervangt de standaardpoort (voor tests). De body zegt dan "geen e2e-bewijs" in plaats van "met e2e". |
| `--nu <jjjjmmdd-hhmm>` | Bepaalt alleen de naam van de tak (`wachtrij/<stempel>`). Het stiltevenster gaat altijd op de echte klok. |
| `--ci-wacht <s>` | Seconden (standaard 30, of env `LAB_WACHTRIJ_CI_WACHT`) die na het openen van de integratie-PR gewacht wordt op de eerste CI-CheckRun (`__typename` CheckRun, `workflowName` CI; Vercel-entries tellen niet). Is er dan nog geen, dan staat in de uitvoer `WAARSCHUWING: geen CI-run voor <sha7>; sluit en heropen de PR of push opnieuw`. |
| `--map <pad>` | Pad van de worktree. |
| `--basis <ref>` | Basis van de wachtrij en van de poort (`--base`), standaard `origin/main`; de body noemt deze basis. De integratie-PR zelf gaat altijd naar `main`. |

## push.sh

```sh
scripts/lead/push.sh                         # huidige tak naar origin/<tak>, met upstream
scripts/lead/push.sh --droog                 # alleen tonen
scripts/lead/push.sh --verwijder lead/x      # remote tak weg, alleen als hij in origin/main zit
```

Pusht met een expliciete refspec (`git push -u origin refs/heads/<tak>:refs/heads/<tak>`), dus `push.default`, `remote.origin.push` of een upstream die naar `origin/main` wijst (zoals bij een verse agenttak vanaf `origin/main`) spelen geen rol. Gewone `git`; `gh` alleen bij `--verwijder` op een GitHub-remote. In een andere repo met het volledige pad naar deze checkout (push.sh wordt niet geïnstalleerd, zie "Vangnet, geen grens"), maar alleen als die repo een uitvoerbare `.githooks/pre-push` heeft (zie hieronder); de GitLab-repo's hebben die nu niet.

Vóór elke push: `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*` en `GIT_CONFIG_VALUE_*` gaan uit de omgeving; de push draait met `git -c core.hooksPath=<toplevel>/.githooks`, zodat de poort-hook van de repo zelf altijd draait (ook als `core.hooksPath` in de config elders naar wijst), en weigert zonder uitvoerbare `<toplevel>/.githooks/pre-push`. De push-URL van origin moet gelijk zijn aan de fetch-URL, en er mag geen `url.*.pushInsteadOf` in de config staan.

Weigert met exit 1 en een reden:

- tak `main` of `master`, of detached HEAD;
- elke force-vorm: `-f`, `--force`, `--force-with-lease`, `--force-if-includes`, `--mirror`, samengestelde korte opties met `f` (`-uf`) en een refspec met `+`;
- `--no-verify`, `--delete`/`-d`, een refspec of elke andere optie;
- een andere remote dan `origin` (alleen `origin` mag als argument);
- een tak die (ook) in een andere worktree is uitgecheckt dan de huidige (`git worktree list`).

`POORT_OVERSLAAN` wordt nooit doorgegeven (`env -u`): de pre-push-hook draait gewoon.

`--verwijder <tak>`: alleen een exacte taknaam (`git check-ref-format`, geen `*`, `?`, `[`, niet met `-`), nooit `main`/`master`. Het script haalt `origin/main` en `origin/<tak>` vers op, eist `git merge-base --is-ancestor origin/<tak> origin/main` en verwijdert met `--force-with-lease=refs/heads/<tak>:<sha>` als slot: is de tak na de controle nog verschoven, dan weigert git. Is `remote.origin.url` een GitHub-URL en is `gh` er, dan eist het script ook een gemergede PR van die tak (`gh pr list --repo <eigenaar/repo> --head <tak> --state merged`); faalt `gh`, dan weigert het. Ook bij verwijderen draait de pre-push-hook.

## vraag-brian.ts

Vraag Brian om een commando via de kaart in Terminal B (commando-knop; de gedeelde modules staan in `packages/lab-commando`). Een agent vraagt een **soort** met parameters, geen shellregel; Brian keurt het goed met Face ID; een vaste runner voert het uit na controle van de passkey-handtekening. Fase 1 live: `tailnet-open` en `tailnet-dicht`. `tak-weg` en `proef-echo` bestaan alleen zonder `TMUX_PWA_LIVE` (live draait `push.sh` uit een clone die een agent kan schrijven; `tak-weg` komt terug in fase 1b, via de GitHub-API). Plan: `~/vault-b-status/brian-commando/PLAN.md`.

```sh
bun scripts/lead/vraag-brian.ts tailnet-dicht --https 8450 --waarom "demo klaar"     # id op stdout (tak-weg bestaat alleen in teststand)
bun scripts/lead/vraag-brian.ts --waarom "…" -- /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --https=8450 off   # argv herkend als soort
bun scripts/lead/vraag-brian.ts soorten | lees <id> [--json] | wacht <id> [--max 30m] | trek-in <id>
```

| Onderdeel | Gedrag |
|---|---|
| Indienen | Vraagt `LAB_AGENT_ROL`; `door` = `LAB_AGENT_NAAM`, `lead` = `LAB_LEAD_NAAM` (de lead zelf: haar naam). `--waarom` verplicht (≤ 500 tekens). Hetzelfde open verzoek geeft het bestaande id terug. `--droog` toont verzoek, hash, kaarttekst en argv en schrijft niets. |
| Limieten | 5 open per indiener, 20 open in totaal, `maxPerDag` per soort in 24 uur (exit 3). Een verzoek verloopt na 24 uur. |
| Afwijzing | Onbekende soort, kwade param of een `-- <argv>` die geen soort maakt: exit 2, met de lijst soorten, en een regel in `afgewezen.jsonl` (zo zien we welke soort de volgende is). Vrije tekst gaat nooit door. |
| Opslag | `${LAB_COMMANDO:-~/.local/state/lab-commando}` (700/600), atomair schrijven, lezen zonder symlinks. Tests gebruiken een tijdelijke `LAB_COMMANDO` en `LAB_LEAD_STAAT`. |
| Uitslag | Exit 0 bij `klaar`; de lead krijgt een korte regel in de inbox (≤ 512 B), de volle geredigeerde staart (20 regels) staat in `uitslag/<id>.json` en komt met `lees`. |

De server en de runner importeren `@lab-bawuah/lab-commando` (`packages/lab-commando/src`), niet dit bestand.

## lab-lees.sh

```sh
scripts/lead/lab-lees.sh get pods -n <namespace> -o wide
scripts/lead/lab-lees.sh logs deploy/web --since=1h
scripts/lead/lab-lees.sh auth can-i list pods -n <namespace>
scripts/lead/lab-lees.sh describe pod/web-1 --droog
```

Alleen-lezen op het lab via `ssh jump`: draait `ssh -T jump oc <args>` met een vaste argv. Toegestaan zijn `get`, `describe`, `logs`, `events`, `top` en `auth can-i`; elk ander subcommando weigert. Altijd geweigerd:

- elk argument met `secret` erin (hoofdletterongevoelig: `secrets`, `secret/x`, `pods,Secrets`, ook bij `auth can-i`), dus ook `-o yaml|json` op secrets;
- de woorden `exec`, `rsh`, `port-forward`, `cp`, `debug`, `edit`, `apply`, `delete`, `patch`, `scale`, `rollout` (en `attach`, `run`, `create`, `replace`, `label`, `annotate`, `set`, `expose`, `proxy`) als argument;
- `--raw`; opties die identiteit of doel wijzigen (`--token`, `--as*`, `--kubeconfig`, `--server`/`-s`, `--context`, `--cluster`, `--user`, client-certificaten, `--insecure-skip-tls-verify`); `-f`/`--filename` en `-k`/`--kustomize` (behalve `logs -f`, volgen);
- elk argument met een teken buiten `[A-Za-z0-9._:/=,@-]`. ssh plakt de argv aan de jump-kant aan elkaar voor de shell daar; zonder spatie, quote, `; | & $ \` \ * ? [ ] { } ~ ! < >` of regeleinde blijft elk argument één woord zonder expansie. 
- `-o`/`--output` (ook `-o=…`, `-oyaml`, `--output=…`) alleen `wide`, `name`, `yaml` of `json`; geen jsonpath, custom-columns of templates. `-o yaml|json` alleen bij `get` en alleen op `pods`, `deployments`, `services` en `endpoints` (met hun korte namen, als soort of `soort/naam`); niet op `configmap`/`cm`, `route`, `oauthclient`, `bc`, `dc` of `all` (`get all -o wide` mag wel). Bij `-o yaml|json` moet een onbekende lange optie de vorm `--optie=waarde` hebben, zodat zeker is welk woord de resource is;
- `--template*`, elk argument met `-file` erin, `--cache-dir*`, `--log*` (ook `--loglevel`, `--logtostderr`), `-v`, `--v`, `--v=…`, `--vmodule*`;
- samengestelde korte opties (`-Ao`, `-lapp=x`): schrijf korte opties los (`-n <ns>`, `-l app=x`), behalve de `-o<vorm>`-vormen.

Secrets via configmaps, routes of env van pods zijn hiermee niet dicht (`describe configmap` toont data): dat vraagt een read-only account met een smalle rol aan de lab-kant.

Stdout en stderr gaan elk door het masker `sed -E "s/eag_[A-Za-z0-9]+/eag_<…>/g"`; de exitcode van ssh blijft. De tests (`lab-lees.test.ts`) gebruiken een nep-`ssh` vooraan op `PATH`; het lab wordt nooit aangeroepen.

## .githooks/pre-push

Draait `bun run check` vóór elke push. `POORT_OVERSLAAN=1` slaat de poort over, maar alleen voor Brian: is `LAB_AGENT_ROL` gezet (spawn.sh zet die voor elke sessie), dan weigert de hook met "Alleen Brian mag de poort overslaan". `--no-verify` slaat de hook helemaal over; dat vangt `hooks/grenzen.sh` (een rauwe `git push --no-verify` wordt geweigerd). Getest in `push.test.ts` met een nep-`bun`.

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
| H4 | PostToolUse (`SendMessage`) | `SendMessage` aan de eigen lead: rapport binnen; `vrij` alleen als de laatste regel van het bericht `vrij` is; `wacht_tot` als de laatste regel `wacht op achtergrondrun tot ~HH:MM` is |
| H5 | Notification (`permission_prompt`, `idle_prompt`) | `goedkeuring` of `idle`, met een melding aan de lead |
| H6 | Stop (agent, sublead, vervolg) | de gate, zie onder; anders `klaar`, `vrij` of `idle`, met een melding |
| H7 | Stop (lead) | ongelezen meldingen: eenmalig `decision: block` met de regels; elke regel komt één keer aan (slotmap tegen een gelijktijdige wekker, identieke regels vallen samen) |
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

Een agent die na minstens één tool stopt zonder `SendMessage` aan de lead krijgt `{"decision":"block","reason":"Je stopt zonder rapport aan <lead>. …"}`. Rem: hoogstens 3 blokkades per reeks, daarna doorlaten met één melding "stopte 3× zonder rapport" (zonder extra idle-regel; de teller begint dan opnieuw). Idle wordt alleen gemeld bij een overgang: een sessie die al idle was en zonder tools weer stopt, meldt niets. Een sessie die op een achtergrondrun wacht, sluit haar rapport af met de vaste slotregel `wacht op achtergrondrun tot ~HH:MM`; hoogstens 2 uur vooruit (een verstreken of verdere tijd telt niet), en tot dan zijn de gate, de idle-melding en de 3×-melding stil (`status.sh` toont `idle (wacht ~HH:MM)`). Geen blokkade bij `stop_hook_active` (de tweede stop gaat door), zonder tools in de beurt, of zolang er een subagent van de sessie bezig is.

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

De bron van de PreToolUse-hook `grenzen.sh` (sleutels, uitrolscripts, pkill/killall, stiltevenster, rauwe merge via gh, rauwe push en rauw lab) staat nu in de repo, met tests in `hooks/grenzen.test.ts`. De strenge oude check blijft op het hele commando draaien. Eén bewerking gaat eraan vooraf: de waarde van `-m`/`--message` bij `git commit`/`git tag`, `--title`/`--body` bij `gh pr create|edit|comment` en `gh issue`, en `--title`/`--description`/`--message` bij `glab mr create|update|note` wordt leeggemaakt, maar alleen als het hele commando geen van de tekens ``$ ` \ # < > { } ! * ? [`` bevat (dan zijn de quote-regels van bash, zsh en sh gelijk) en de waarde één quote-token is zonder het andere quoteteken erin. Daardoor kan de hook niets doorlaten wat de oude weigerde, behalve tekst in die berichtargumenten (de eigenschapstest bewaakt dat tegen `hooks/fixtures/grenzen-oud.sh`). Brian installeert de hook met `cp scripts/lead/hooks/grenzen.sh ~/.claude/hooks/grenzen.sh`; agents raken `~/.claude` niet aan.

**Rauwe push en rauw lab (17 okt 2026).** Een `git push` met een force-vorm (`-f`, `--force*`, `--mirror`, `-uf`, `+refspec`), met verwijderen (`--delete`, `-d`, `--prune`, `:tak`), naar main (`main`, `HEAD:main`, `x:refs/heads/main`, `--all`), met `--no-verify` of met `POORT_OVERSLAAN` ergens in het commando wordt geweigerd met de verwijzing naar `scripts/lead/push.sh`; een `ssh` naar `jump` (ook `user@jump`, `-J jump`) met `oc` in het commando met de verwijzing naar `scripts/lead/lab-lees.sh`. Streng zoals de rest: segmenten en woorden worden gesplitst zonder op quotes te letten, dus `bash -c '…'`, `ssh host '…'`, `nice …` en `git -C x push` tellen ook. Alleen een segment dat met `echo`, `printf`, `grep` of `rg` begint, telt niet; berichtargumenten zijn al leeggemaakt. Een gewone `git push` of `git push -u origin <tak>` blijft toegestaan.

**Herstelronde #153.** Daarnaast weigert de hook: afgekorte lange push-opties (git neemt een unieke prefix aan: `--forc`, `--del`, `--no-veri`, `--al`; elk `--`-woord van minstens twee letters dat een prefix is van een verboden optie), `HEAD:Main` en `MASTER` hoofdletterongevoelig, `git push`/`git push origin`/`git push origin HEAD` als de huidige tak (in `cwd` uit de hookinvoer, na `cd x &&` of `git -C x`) `main` of `master` is, `git -c` met `alias.*` of `core.hooksPath`, `--config-env` bij een push, `GIT_CONFIG` in een push-commando, `git config alias.*` en `git config core.hooksPath`, en een schrijvende `gh api` (zie hieronder). Een subagent of fork (`agent_id` of `agent_type` in de hookinvoer) draait `merge.sh` nooit, ongeacht het pad en ongeacht `LAB_AGENT_ROL` (die erft mee via env); lezen (`cat`, `git diff`, `grep`) mag wel.

**Herstelronde #153b.** De `gh`-toets werkt op de woorden (quotes weg) en slaat gh-vlaggen met een waarde (`-R o/r`, `--repo`, `--hostname`) over tot het subcommando. Geweigerd: `gh pr merge` (ook `gh -R o/r pr merge`, `gh "pr" 'merge'`) zodra de merge-toets aan staat; `gh alias set|import`; een `gh api` die schrijft: een methode anders dan GET (`-X`, `-XPUT`, `--method`, `--method=`), of `-f`/`-F`/`--field`/`--raw-field`/`--input` zonder expliciete `-X GET`/`--method GET` (gh maakt er dan een POST van); `gh api graphql` met `mutation` erin, of met een query uit een bestand (`--input`, `=@`). Lezen mag: `gh api repos/o/r/pulls/1/merge` en `.../git/refs/...` met GET, en een graphql-`query`.

**Here-doc-berichten.** `gh pr create|edit|comment --body "$(cat <<'EOF' … EOF\n)"` en `git commit -m "$(cat <<EOF … EOF\n)"` worden vóór de toets `--body ''`, zodat PR-teksten geen valse weigering geven. Alleen als alles ervóór op de regel eenduidig is (het commando aan het begin, eventueel na één `cd <map> && `, of `git -C <map> commit`; verder gewone woorden en eenvoudige quotes), de tekst geen eerdere regel met de eindmarkering heeft (anders stopt bash daar en is de rest een commando) en bij een ongequote marker geen `$`, backtick of `\` bevat. Wat na de here-doc komt, wordt gewoon getoetst; bij twijfel blijft het commando streng.

**Faalt dicht.** Een eigen fout van de hook (geen geldige JSON, invoer van de verkeerde vorm zoals `tool_input` als string, of een python-status anders dan 0 of 2) geeft exit 2 met één melding ("Geweigerd door grenzen.sh: eigen fout (…); faalt dicht"): weigeren. 0 blijft toestaan. De hookinvoer gaat via stdin naar python, niet via argv, dus ook een commando van honderden kB wordt getoetst (geen ARG_MAX).
