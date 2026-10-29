# Testpensioen en vervangende dekking

Basis: `003773bfda5b913e2698562cb9805c1a31720374`. Onderstaande gedeclareerde testnamen zijn verwijderd of vervangen omdat het getoetste agentbeleid is gepensioneerd. Dit is geen uitsluiting van falende correctnesschecks. Bestaande inhouds-, eigenaars-, native-trust-, Git-hardening-, private-opslag-, argument- en betrouwbaarheidschecks blijven in de suite.

De retirementreferentie `364a580` is selectief hergebruikt; deze lijst is opnieuw tegen de eigen Relay-basis berekend. `TESTS-UITGESLOTEN.md` verandert niet: er zijn geen nieuwe producttests uitgesloten. De volledige grenzen- en privileged workerpush-testbestanden vervallen met hun runtimebeleid. De grenzenbron bevat uitsluitend de compatibiliteitsshim. Product-WebAuthn, passkeys, native approvals en veilige installatie zijn behouden.

Vervangende dekking: `peers/policy-retirement.test.ts` (17 niet-gerelateerde peers met read/ack/reply, rolvrije expliciete recovery, foreign ack/identiteit, onderbroken herstel na retentie en behoud van corrupte/foreign heldregels), aangepaste bus/CLI-tests, niet-blokkerende Stop-tests, optionele native-trustvrije installerupgrade, rolvrije wekker en behoud van `lead-proef`-binding.

De Git-bronscan behoudt dezelfde opties en minimumtelling. Dode uitzonderingen voor de verwijderde merge-stempelcode en oude workflowprompt zijn verwijderd; de spawn-promptuitzondering is aan de gewijzigde tekst gekoppeld. De nieuwe optionele workflow gebruikt een nepagents-test, geen provideroproepen.

## scripts/lead/beleid/beleid.test.ts

De generator produceert geen grenzenpolicy meer; andere hostinstellingen en eigen optionele events blijven behouden.

- snapshot: met grenzen en wekker in Brians settings
- met grenzen: Brians entry zonder markering wordt overgenomen (één entry, gemarkeerd) en verwijderen haalt hem weg

## scripts/lead/hooks/codex-adapter.test.ts

De rapportgate vervalt; rapportherkenning, herkomst en privacy blijven.

- een hele beurt zonder rapport: Stop blokkeert (de gate blijft aan voor Codex); bij stop_hook_active gaat hij door als idle
- K2: de Stop-gate noemt voor Codex mcp__peers__send, voor Claude SendMessage

## scripts/lead/hooks/codex-installeer.test.ts

Verplichte grenzenhook en automatisch vertrouwen verdwijnen. Backup, modus, idempotentie, upgrade en native-instellingen blijven getest.

- M1: een tweede PreToolUse-groep draait grenzen.sh via de wrapper, met een matcher die Bash en apply_patch dekt
- eerste run: backup van het origineel, blok, bestanden, vertrouwen voor alle hooks; modus van config blijft
- tweede run is idempotent: config byte-voor-byte gelijk, backup ongemoeid, niets opnieuw vertrouwd
- een ander pad (hook wordt 'modified') wordt opnieuw vertrouwd; de backup blijft het origineel
- M1: na de installer ziet controleerGrenzen een vertrouwde grenzen-hook; zonder trust, zonder entry of met een kapotte hash niet
- a) alleen het exacte installer-commando telt: een commando dat de tekst grenzen.sh noemt met een nep-hash gaat niet door
- a/c) ontbrekende of niet-uitvoerbare delen en een verouderde kopie van grenzen.sh, codex-wrap of register.ts worden gevonden
- woorden: splitst zoals shq quote (spaties in een pad, een aanhalingsteken)
- app-server start niet: fout met uitleg, hooks staan er wel, exit 1
- Codex ziet minder hooks dan verwacht, of vertrouwen blijft hangen: fout

## scripts/lead/hooks/codex-wrap.test.ts

Home-/rolvoorrang en fail-closed governance verdwijnen. Private identiteit, tijd, naam, daemonisolatie en bestaande lead-proef-binding blijven getest.

- Z1: een identiteit met rol lead (of een onbekende of lege rol), zonder naam of met een ts uit de toekomst is ongeldig
- lead-proef-home faalt dicht bij een oude daemon, /new en een kind dat eerst bindt
- lead-home heeft voorrang op een geldige werker-identiteit in de cwd
- lead-proef-home vergelijkt absolute paden met de systeembasis; .codex-lead faalt dicht
- Z5: zonder bun faalt de wrapper luid bij PreToolUse (exit 2, geen commando) en is hij stil bij andere events
- PreToolUse: exit 2 met uitleg (Codex leest exit 1 als niet-blokkerend, dus fail-open); andere events exit 1
- een Codex-hook zonder LAB_AGENT_ROL in zijn eigen omgeving krijgt de rol uit de identiteit: git fetch in de hoofdcheckout wordt geweigerd; zonder identiteit niet

## scripts/lead/hooks/grenzen.test.ts

De globale commandopolicy is verwijderd. Product-/sleutelregels uit deze generieke hook worden niet als alternatieve productveiligheidslaag geïnstalleerd; productbeveiliging en native approvals blijven bij hun eigen bron.

- weigert tmux send-keys en paste-buffer naar een andere pane of sessie
- laat de eigen pane en een tmux-opdracht zonder doel door
- weigert redirects naar /tmp/cc-socks, maar niet lezen
- laat alleen de vaste merge.sh vanaf de hoofdcheckout door
- weigert merge-omweg: ${naam}
- mutatie: zonder de mergepadcheck wordt elke merge-omweg open
- weigert push-werker, gh pr merge en een roltoewijzing
- weigert rauwe gh- en curl-mergepaden ook voor de gewone lead
- laat leesacties op merge- en pushwerkercode door
- weigert roltoewijzing en git -c ook als git verder alleen leest
- weigert ${JSON.stringify(c)}
- laat door ${JSON.stringify(c)}
- eigenschap: nieuw laat alleen door wat oud ook doorliet, of wat in de witte lijst valt
- een rauwe push of ssh jump … oc verwijst naar het smalle script
- Read van een sleutelbestand wordt geweigerd, .example mag
- ongeldige invoer faalt dicht (exit 2, één melding)
- invoer van de verkeerde vorm faalt dicht: tool_input als string of lijst, JSON als lijst
- een kapotte python-stap faalt dicht (exit 2)
- een commando van meer dan 300 kB gaat via stdin en wordt nog getoetst
- weigert ${JSON.stringify(c)} met agent_id of agent_type
- lezen van merge.sh mag ook voor een subagent
- weigert ${JSON.stringify(c)}
- lezen van een PR mag
- weigert \`git push\` en \`git push origin HEAD\` als de huidige tak main of master is
- laat \`git push\` door op een eigen tak
- de here-doc-tekst van gh pr create en git commit wordt leeggemaakt
- ook met een kop \`cd x && …\` of \`git -C x commit\`
- wat na de here-doc komt, wordt nog getoetst
- streng bij twijfel
- een nieuw te groot bestand wordt geweigerd, met grootte, limiet en oplossing
- een klein bestand en een bestand precies op de limiet mogen
- bytes tellen, geen tekens
- een Edit die een groot bestand laat groeien wordt geweigerd; krimpen of gelijk blijven mag
- replace_all telt elk voorkomen; MultiEdit telt alle edits
- een Edit op een ontbrekend bestand is geen eigen fout: alleen de nieuwe tekst telt
- uitzonderingen: lead.md in de root, archief/ en emb-gemma/
- een .md buiten de vault en een niet-.md in de vault mogen
- LAB_VAULT_MAX_KB verlegt de limiet
- weigert ${JSON.stringify(c)}
- laat door ${JSON.stringify(c)}
- de melding noemt het juiste commando en wat ontbreekt
- kustomize: weigert ${JSON.stringify(c)}
- kustomize: laat door ${JSON.stringify(c)}
- het woord in een commit-bericht met heredoc geeft geen vals alarm
- een relatieve map volgt de cwd uit de invoer
- de melding noemt het doel, de kustomization-map en het alternatief
- agent in de hoofdcheckout: weigert ${JSON.stringify(c)}
- agent in de hoofdcheckout: laat door ${JSON.stringify(c)}
- een cd weg en terug telt per segment
- een linked worktree als cwd mag alles
- een clone als cwd mag alles
- een submap van een linked worktree mag
- een submap van de hoofdcheckout telt als hoofdcheckout
- een cd na een onbepaalbare cd crasht niet (gc-query: scratchpad, daarna git -C op de eigen worktree)
- git branch -d vanuit een eigen worktree na een onbepaalbare cd crasht niet (gc-poort)
- een absoluut pad na een onbepaalbare cd legt de werkmap weer vast: de hoofdcheckout blijft geweigerd
- een kustomize-render na een onbepaalbare cd crasht niet maar wordt geweigerd
- buiten een repo geen bezwaar
- de lead mag wel in de hoofdcheckout
- zonder LAB_AGENT_ROL en zonder subagent-velden (Brian) mag het
- elke andere rol (sublead, vervolg, agent) wordt geweigerd
- een subagent of fork wordt geweigerd, ook als de rol lead erft of ontbreekt
- de melding noemt het commando, de map en wat te doen
- de echte Codex-fixture (Add File y.txt) mag
- gewone patches (Add, Update, Delete, Move to, meerdere bestanden) mogen
- ${soort} ${pad} wordt geweigerd
- Move to naar een sleutelbestand, en een Move vanaf een sleutelbestand, wordt geweigerd
- ~/.claude en ~/.codex (ook relatief aan cwd of met ~) worden geweigerd
- een sleutelbestand verderop in een patch met meer bestanden weigert de hele patch
- een padstuk als .envrc of config.jsonl is geen sleutelbestand
- een symlink naar een sleutelbestand wordt geweigerd
- een nieuw te groot bestand wordt geweigerd, met grootte en oplossing
- paden relatief aan cwd tellen mee
- klein mag, precies op de grens mag, 1 byte erboven niet
- een Update die een bestaande notitie boven de grens laat groeien wordt geweigerd; krimpen of gelijk mag
- een Update waarvan de context niet in het bestand staat telt + en - regels
- Move to naar een vaultnotitie telt de grootte van het resultaat
- Delete in de vault mag; lead.md, archief/ en niet-.md mogen groot; spoor/lead.md niet
- LAB_VAULT_MAX_KB wordt gevolgd
- een agent mag geen bestand schrijven in de hoofdcheckout (Add, Update, Delete, Move, submap)
- relatief aan een cwd in de hoofdcheckout telt ook
- een eigen worktree en een map buiten een repo mogen
- de lead en Brian (zonder rol, zonder subagent-velden) mogen in de hoofdcheckout
- een subagent wordt geweigerd, ook met rol lead of zonder rol
- meerdere hunks: een hunk met alleen +regels stopt de telling niet (38 KB + 6000 tekens in een latere hunk)
- een Add File in .git van de hoofdcheckout (hooks) wordt geweigerd, absoluut en vanuit een worktree
- .env.production.local en .env.local zijn sleutelbestanden; .example en .envrc niet
- hoofdletters: .ENV, Config.JSON, CONFIG.PROPERTIES en ~/.CLAUDE tellen als sleutel
- hoofdletters: GROOT.MD in de vault valt onder de grootteregel, LEAD.MD en ARCHIEF/ onder de uitzonderingen
- $CODEX_HOME wordt beschermd naast ~/.codex
- N1: .git in andere hoofdletters, en een .git-pad in kleine letters, tellen als hoofdcheckout (puur op strings, dus ook op Linux)
- N2: een min-regel die niet exact matcht telt niet als krimp (38 KB + fuzzy min van 5000 en plus van 5500)
- een symlink naar de vault omzeilt de grootteregel niet
- een pad dat met ~ begint wordt niet aangevuld maar geweigerd, met uitleg
- zonder command-veld
- een tool die niet apply_patch heet wordt niet als patch gelezen
- een onleesbare procesmap: een onschuldige Bash-aanroep gaat door (rc 0; als root niet te maken)
- een json.py in de procesmap wordt niet geïmporteerd (geen markeerbestand)
- mutatie: zonder -I importeert python de json.py uit de procesmap wel
- mutatie (alleen macOS): zonder -I faalt de hook bij een onleesbare procesmap

## scripts/lead/hooks/hook-bus.test.ts

Stop-blokkades op rapportage/inbox vervallen; tellers, promptcontext en idlebezorging blijven.

- Stop blokkeert één keer met het seintje; de tweede stop (stop_hook_active) gaat door
- de rapport-gate blijft aan en krijgt het seintje erbij; de gate telt zijn blokkades
- een lead met post: Stop blokkeert één keer met het seintje
- Stop blokkeert alleen bij een stijging sinds het laatste seintje: een sessie die niet leest krijgt geen extra ronde per Stop

## scripts/lead/hooks/hook.test.ts

Stop blokkeert niet meer; registratierollen zijn labels en de optionele wekker bedient eigen meldingen voor elk label. Status, privacy en routering blijven.

- a) lege LAB_AGENT_ROL: stopt in sh, bun wordt niet gestart
- exit 2 van de wekker gaat door met stderr; JSON van de gate op stdout; kapotte stdin = exit 0
- rol leeg of onbekend: er wordt niets geschreven
- fix: 3×-melding komt eenmaal per reeks, zonder extra idle-regel
- blokkeert bij ≥1 tool zonder rapport (${rol}); reden noemt de lead en de ene-zin-uitweg
- rem: hoogstens 3 blokkades per sessie, daarna doorlaten met een inbox-regel
- b) laat de stop door zolang subagents van deze sessie lopen; daarna weer blokkeren
- c) de beurtteller reset na een doorgelaten Stop, ook zonder UserPromptSubmit
- d) H7 blokkeert alleen bij nieuwe regels en nooit twee keer voor dezelfde
- via verwerk: alleen voor rol lead
- een Stop met agent_id valt nog gewoon onder de rapport-gate (alleen UserPromptSubmit wordt gefilterd)

## scripts/lead/hooks/installatie.test.ts

De verwijderde verplichte governancecontrole vervalt; echte laadtests van optionele gekopieerde hooks blijven.

- codex-installeer: de geïnstalleerde wrapper, hook.sh en grenzen-groep laden en draaien vanuit de installatiemap
- een geïnstalleerde wrapper die niet laadt (ontbrekend peers-bestand) geeft een reden met de fout; een volledige installatie niet

## scripts/lead/installeer-grens.test.ts

Alleen de mergewrapperinstallatie vervalt. Beschermde runner, publieke export, ACL-/eigenaar-/modus-/symlinkchecks blijven.

- installeert alleen merge.sh en lead.conf
- print de sudo-commando's (root:wheel, 755/644) en de shasum-controle, en voert zelf niets uit
- weigert te printen als de werkkopie afwijkt van origin/main
- quote een bronpad met een spatie of quote
- --controleer vergelijkt met origin/main, niet met de werkkopie
- --controleer: FOUT bij een andere inhoud, modus, eigenaar, symlink of ontbrekend bestand
- zonder runner in origin/main blijft het bij merge.sh en lead.conf

## scripts/lead/lead-codex.test.ts

Profiel-/login-/vlag- en proefrolbeperkingen vervallen; bestaande vendorconfiguratie, private identiteit en eigen cleanup blijven.

- controleert het profiel en de inlog, start met lead-proef-identiteit en ruimt die daarna op
- start niet zonder groen profiel of inlog en laat dan geen identiteit achter
- start met een danger-full-access-profiel zonder CLI-sandboxomweg
- de werkruimte-identiteit bindt aan één SessionStart; hoofdcheckout en zusterworktree krijgen geen lek
- accepteert alleen één gewone prompt en weigert alle Codex-vlaggen

## scripts/lead/lead.test.ts

Verplichte profielen, rapport-/workflowpolicy, actualiteitsfetch, rol-/reviewmarker- en poortstempelchecks vervallen. Gewone CI, headvergelijking, native vragen, input-/worktree-identiteit en veilige installatie blijven.

- weigert zonder Lead-review-comment
- weigert een akkoord voor een oudere head (push na akkoord)
- alleen lead en lead-proef mergen: andere rollen weigeren, --droog mag wel
- stempel op de head (affected, basis = main): akkoord; --droog noemt de stempel
- stempel op een oudere commit met dezelfde patch: akkoord
- update-branch: main in de tak gemerged, stempel van vóór de merge: akkoord
- patch gewijzigd na de stempel: geweigerd
- geen stempel: geweigerd, met de opdracht om de poort te draaien; ook --droog
- rode, onleesbare of oude stempel (zonder groen): geweigerd
- stempel met een basis die geen voorouder van main is (--base HEAD): geweigerd
- een symlink als stempel telt niet
- gh compare faalt: geweigerd (fail-closed)
- met een geldige stempel merget hij echt
- gelijk met origin/main: door, zonder melding (ook zonder fetch-resultaat)
- achter in scripts/lead/: weigert (ook --droog en --vendor codex), met pull --ff-only voor die checkout
- achter buiten scripts/lead/: door; een tak die vooruit loopt in scripts/lead/ ook
- LAB_SPAWN_NIET_ACTUEEL_OK=1 laat achterlopen toe met een waarschuwing
- fetch mislukt: waarschuwing en vergelijking met de lokale origin/main (achter blijft geweigerd)
- een hangende fetch stopt na LAB_SPAWN_FETCH_S: git zelf is weg (geen wees), spawn gaat door met een waarschuwing
- --meerdere: de ouder toetst eenmaal, de kinderen niet
- geen origin/main of geen repo: waarschuwing en door
- --sublead: startzin met de Agent-tool, zonder workflow
- --sublead --workflow noemt Brians toestemming met de datum; --workflow alleen met --sublead
- werker-home: ontbrekend of ongeldige config weigert; de start pinnt ~/.codex-werker
- --netwerk: de startzin zegt niet pushen (want de lead pusht) en meldt 'klaar om te pushen'; geen install-regel zonder package.json
- M3: een bestaande <worktree>/.codex (ook niet-getrackt, ook een symlink) weigert spawn; zonder .codex slaagt hij
- hosted web search: tmux zet hem uit met -c (ook zonder MCP, ook als de config hem aanzet); T3 weigert als de config hem aanzet
- tmux: spawn zet de upstream van de werkertak vooraf (.git/config is read-only in de sandbox); een bestaande eigen upstream blijft
- M1: zonder grenzen-hook in de Codex-config, of zonder geldige trusted_hash ervoor, start spawn niet (tmux, T3 en --droog)

## scripts/lead/peers/bus.test.ts

Inboundbeleid vervalt. Historische heldtests schrijven nu echte opslagfixtures; wachtrij, tempo, grootte, dedupe en herstel blijven getest.

- inbound refuse: geweigerd, niets opgeslagen
- inbound hold: status vastgehouden, niet in de inbox, niet gewekt; vrijgeven zet hem in de inbox en wekt
- inbound standaard zonder beleid: accept van de eigen lead en van eigen werkers, anders hold
- per_afzender gaat voor standaard, in beide richtingen
- volgorde: refuse gaat voor vol; dubbel gaat voor refuse
- dubbel telt ongeacht de uitkomst van de eerste: een geweigerde poging, daarna dezelfde tekst, is dubbel
- een ongeldige waarde (\"Hold\", \"ACCEPT\", een getal, een object) telt als hold
- een geldige waarde werkt nog: per_afzender refuse gaat voor standaard accept

## scripts/lead/peers/cli.test.ts

De beheerrolcheck vervalt; vervangende tests bewaken dezelfde bediening voor alle labels en weigeren andermans mailbox.

- vasthouden en vrijgeven: toegestaan zonder rol (Brian) en voor de lead, geweigerd voor een andere rol

## scripts/lead/push-werker.test.ts

De privileged workerpushroute met overgeslagen hooks is verwijderd; normale push/ref/lease/native-hookcontroles blijven in push.test.ts.

- pusht <sha> naar een nieuwe tak met een expliciete refspec; de pre-push-hook draait niet; de melding noemt de overgeslagen poort
- een fast-forward van een bestaande tak slaagt
- weigert zonder LAB_AGENT_ROL=lead (ook met een andere rol)
- weigert main en master
- weigert een tak die niet de tak van de werker-worktree is
- weigert een verkeerde sha (niet de HEAD van de werker), een afgekorte sha en een onbekende worktree
- weigert een non-fast-forward van origin/<tak> (geen force)
- weigert met de cwd in de worktree van de werker (ook een submap) en in een map met een werker-identiteit
- weigert als de identiteit geen tak vastlegt of een andere tak (ook als HEAD en de tak zelf kloppen)
- weigert als de werker <gitdir>/HEAD naar een andere tak heeft gezet
- een refs/replace-ref kan de fast-forward-toets niet misleiden (aanval: wees-commit vervangen door origin/<tak>)
- --droog toetst alles maar pusht niet

## scripts/lead/push.test.ts

De verplichte eigen hookinstallatie en rolgebonden skip/tijdvoorwaarden vervallen. Native Git-hooks, refs, leases en beschermde hoofdtakken blijven.

- geeft POORT_OVERSLAAN niet door: de pre-push-hook draait en ziet hem niet
- de hook van de repo draait altijd: core.hooksPath in config of env telt niet
- weigert zonder uitvoerbare .githooks/pre-push
- weigert POORT_OVERSLAAN in een agentsessie (LAB_AGENT_ROL)
- Brian (zonder LAB_AGENT_ROL) mag POORT_OVERSLAAN
- zonder POORT_OVERSLAAN draait de poort, ook voor een agent
- een push die alleen verwijdert draait de poort niet
- ook in het stiltevenster en voor een agent
- een mix van delete en echte push draait de poort
- een delete van main of master is niet vrijgesteld maar geweigerd, ook in een mix
- een lege regel op stdin laat de poort draaien (open falen)
- een update van een bestaande tak (remote sha niet 0) draait de poort
- een tag-delete is vrijgesteld
- een echte push met rode poort blijft geweigerd
- een delete met een rode poort slaagt, want de poort draait niet
- push.sh --verwijder tegen een bare origin: de echte hook ziet delete-only en draait de poort niet
- een rode poort: de weigering noemt het pad dat de hook aan de poort gaf
- twee hook-runs krijgen elk een eigen pad en noemen alleen dat; een POORT_LOGPAD van buiten telt niet
- de logmap is 0700
- een poort die niets schreef: geen pad genoemd
- weigert een agent (LAB_AGENT_ROL) in het venster, zonder de poort te draaien
- Brian (zonder LAB_AGENT_ROL) mag in het venster door tot aan de poort
- een agent buiten het venster komt door tot aan de poort

## scripts/lead/spawn-vertrouwen.test.ts

De globale voorafgaande trustwaarschuwing vervalt; wachten op native vragen, nooit beantwoorden en timeout blijven.

- een niet-vertrouwde map geeft vooraf een waarschuwing; een vertrouwde bovenliggende map niet

## scripts/lead/wachtrij.test.ts

Akkoordmarkers vervallen; geschikte PR-selectie, conflicten, headverschuiving en cleanup blijven.

- neemt alleen PR's met akkoord op de huidige head, op volgorde van nummer
- een akkoord moet aan het begin van de comment staan en de hele sha7 hebben
- een verouderd akkoord telt niet mee (lege wachtrij)


## Reviewcorrecties boven op het eerste checkpoint

De review van `c13a599` vond vijf concrete regressies. Er is vervangende dekking toegevoegd voor malformed heldregels met een geselecteerd ID, corrupte inboxbewijzen, de exact gemarkeerde oude Claude-governancehook, statusbezorging voor `lead-proef`, en rolvrije parentvalidatie met naamambiguïteit. De bestaande binding/lifecycle en native hooks blijven behouden. Recovery stopt bij conflicterende ID-inhoud zonder deze bronbestanden te herschrijven.
