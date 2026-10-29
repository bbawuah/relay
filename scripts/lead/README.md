# Optionele sessie- en PR-hulpmiddelen

Deze map biedt launchers, sessiestatus, peerberichten en een integratiewachtrij. De hulpmiddelen leggen geen eigen agentrollen, reviewmarkers, rapportplicht of lokale poortstempels op. De opdracht van de gebruiker en de bestaande host- en GitHub-instellingen bepalen welke acties toegestaan zijn.

## Sessies starten en volgen

`spawn.sh --naam <naam> --opdracht <bestand> --map <checkout> --lead <naam> [--vendor claude|codex] [--model <model>] [--droog]` start een sessie in tmux en geeft het pane-id terug. `--t3` gebruikt T3; de launcher controleert of de thread werkelijk start. `--meerdere <bestand>` leest `naam opdrachtbestand [model]` per regel en valideert de hele lijst vóór starten. `--vervolg <tak>` geeft een vervolgsessie de bestaande taak en tak; `--sublead` kiest de optionele taakcyclus uit [sublead.md](sublead.md).

Gebruik in T3 bij voorkeur de beschikbare app-tools voor nieuwe threads en worktreebinding. `--map` moet een eigen worktree zijn wanneer de launcher checkout-identiteit opslaat: zo erven andere sessies die identiteit niet. Dubbele namen en bestaande actieve identiteiten geven een fout om verkeerde bezorging te voorkomen.

De launcher gebruikt de bestaande vendorconfiguratie. Geen vaste Codex-home, verplicht governanceprofiel, hooktrustcontrole, websearchbeleid of aangepaste sandbox. Een native vertrouwensvraag wordt aan de gebruiker getoond en nooit automatisch beantwoord. `--droog` toont alleen de stappen. `--netwerk` bij Codex slaat de voorbereidende dependency-installatie over; de overige variant gebruikt de bestaande veilige installatie met `--ignore-scripts --frozen-lockfile` en controleert de installatie-invoer vóór uitvoering.

`lead-codex.sh [argumenten…]` blijft beschikbaar voor Relay. Deze optionele launcher gebruikt de huidige checkout als standaard werkruimte en de bestaande Codex-configuratie. Hij schrijft tijdelijk een private peeridentiteit, weigert een bestaande identiteit en ruimt alleen zijn eigen spawnidentiteit op.

Het bestaande metadata-etiket `lead-proef` blijft in deze launcher behouden omdat nog geïnstalleerde globale guards eraan bevoegdheden kunnen koppelen. De bronreset verhoogt dat etiket niet naar `lead`; een eventuele externe rolmigratie blijft een afzonderlijk besluit van Brian. In de nieuwe repositorytooling legt het etiket geen permissiongate op.

`status.sh [--lead <naam>] [--alles] [--git] [--json]` toont geregistreerde sessies. `hernoem.ts` wijzigt namen en volgers. `leadnaam.ts` helpt bij afzenderroutering. Rollen zijn etiketten voor de statusweergave, geen bevoegdheden.

## Optionele eventregistratie

`installeer-hooks.ts --droog` toont de Claude-eventconfiguratie. Alleen een expliciete installatierun schrijft eigen evententries, met backup en atomair schrijven; andere instellingen blijven staan. `hooks/codex-installeer.ts --droog` toont het Codex-equivalent. Deze installer schrijft geen automatische native hooktrust en installeert geen governancehook. De gebruiker beheert native trust in de host.

De hooks houden toestand, toolnaam en rapporttijd bij zonder prompts, antwoorden of transcripts op te slaan. `UserPromptSubmit` toont aantallen en sessiemeldingen. **Stop blokkeert nooit op ontbrekende rapportage of ongelezen berichten.** De optionele `--met-wekker`-configuratie kan apart een notificatie laten bezorgen via `asyncRewake`.

`hooks/codex-wrap.*` voorkomt dat een gedeelde daemon een bericht namens een andere sessie laat sturen. Private identiteitsbestanden zijn tijdgebonden en sessiegebonden waar een sessie-id aanwezig is. `hooks/grenzen.sh` is uitsluitend een lege compatibiliteitsshim: Relay-exporten verwachten dat pad. Het voert geen agentbeleid uit.

## Peerbus

`peers/cli.ts` en `peers/server.ts` bieden `send`, `inbox`, `list` en idle-notificaties. De CLI biedt ook vasthouden en vrijgeven zonder rolcheck. Naamvalidatie, private opslag, bronmarkering en betrouwbare aflevering blijven behouden. Zie [peers/README.md](peers/README.md). De bus is lokale routering, geen authenticatiegrens.

## PR-hulp

`merge.sh <pr> [--droog] [--contract <bestand> --spoor <id>]` controleert gewone CI en GitHub-mergebaarheid, vergelijkt de gelezen head tijdens het mergen en bewaart afhankelijke PR's voordat een remote tak wordt verwijderd. Een contract is optioneel en geeft alleen waarschuwingen over eigendom. Geen rol, speciaal akkoordcomment of lokaal stempel nodig. GitHub-regels blijven van toepassing.

`push.sh [--droog]` pusht de huidige tak met een expliciete refspec en de bestaande Git-hooks. `push.sh --verwijder <tak> [--droog]` behoudt de product-CLI voor het opruimen van gemergede remote takken. De helper valideert refs, bewaart main/master, gebruikt een lease bij verwijderen en weigert onveilige argumenten. Er is geen verplichte lokale hookinstallatie. De bijzondere worker-pushroute is verwijderd.

`wachtrij.ts --droog` toont geschikte open PR's zonder verplichte akkoordmarker. Een echte opt-in run bouwt een integratietak, draait de ingestelde controles en kan een integratie-PR openen. Conflicten, verschoven heads, foutuitkomsten, stiltevenster en opruimvoorwaarden blijven zichtbaar. Gebruik de helper alleen voor acties die de gebruiker heeft opgedragen.

## Productcommandorunner

`installeer-grens.ts` behoudt uitsluitend de installatie van de WebAuthn-commandorunner. Bundelen uit `origin/main`, veilige eigenaars-/modus-/ACL-controles, passkeyvalidatie en de LaunchAgent blijven behouden. Er wordt geen merge-wrapper meer geïnstalleerd. De bestaande bestandsnaam blijft voor callers beschikbaar. Zie [commando/INSTALLEREN.md](commando/INSTALLEREN.md) voor de productinstallatie en de afzonderlijke migratie van eerder geïnstalleerde kopieën.

## Activeringsgrens

Bronwijzigingen vervangen geen geïnstalleerde globale hooks, homes, vaste kopieën of GitHub-regels. Een eventuele latere aanpassing daarvan is een afzonderlijke gebruikersactie na review. Deze reset voert geen installer, uitrol, push of merge uit. Testpensioen en de behouden dekking staan in [TESTPENSIOEN.md](TESTPENSIOEN.md).
