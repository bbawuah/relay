# Activering en expliciet herstel

Dit is de overdracht aan root; de worker heeft geen globale/live bestanden, actieve sessies of wachtrijen gewijzigd. Alle validatie en schermafbeeldingen gebruiken wegwerpstaat. Root bezit integratie, live activering en merge.

## Geïnstalleerde kopieën

Read-only inventaris op 29 oktober 2026: `~/.local/bin/relay` wijst naar `/Users/labbawuah/relay/scripts/lead/relay.ts`, dus niet naar deze worktree. De oorspronkelijke checkout heeft nog drie ongepubliceerde basiscommits en is niet overschreven.

De geïnstalleerde lead-home bevat de gerepareerde 229-byte `grenzen.sh` met SHA256 `069ef0a540fd0027ed42a060af4300fb21f67acf7779d887eda671dbc85bb56a`. Maar `hook.ts`, `hook.sh`, `codex-wrap.*` en `register.ts` daar zijn nog dezelfde oudere generatie als `/Users/labbawuah/relay`. `~/.codex`, `~/.codex-werker` en de Claude-hookmap bevatten weer een andere generatie. Exacte paden, groottes en hashes staan in [installed-copies.json](installed-copies.json). Dit is een momentopname; root moet vóór activering opnieuw vergelijken.

## Na review, door root

1. Bevestig de stackbase `feat/relay-codex-default` en coördineer de drie ontbrekende basiscommits. Merge deze legacy launcherboom niet naar de message-only remote main. Leg de geteste en gereviewde bron-SHA vast.
2. Kies één canonieke launchercheckout of installatie. Behoud de oorspronkelijke checkout en al het gebruikerswerk. Pas de symlink alleen aan volgens het integratiebesluit; een clone of herinstallatie van oude bron mag de retired guards niet opnieuw kopiëren.
3. Inventariseer alleen de eigen hookregistraties en codekopieën voor de werkelijk gebruikte homes. Maak private backups met hashes van settings, scripts en eventuele startupinstallerverwijzingen. Bewaar native/producthooks, native approvalinstellingen en providertrust.
4. Bekijk `installeer-hooks.ts --droog --settings <expliciet-pad> --doel <expliciete-map>` en `hooks/codex-installeer.ts --droog --codex-home <expliciete-home> --doel <expliciete-map>` vanuit de gekozen bron. De nieuwe Codex-installer vervangt alleen het eigen gemarkeerde blok, kopieert status/routering en vraagt geen automatische trust. De Claude-installer bewaart andere entries. Een handmatige oude grens-entry buiten het eigen blok vereist afzonderlijke gerichte reconciliatie; geen brede hookverwijdering.
5. Reconcileer de hele gekozen codekopie, inclusief `hook.ts`, `hook.sh`, `codex-wrap.*`, `register.ts`, `hooks/register.ts` en `peers/{afgeleide-naam,bus,standaard,types,uuid,wekker}.ts`. Alleen `grenzen.sh` vervangen laat oude rapportblokkades en wrappergedrag bestaan. Verifieer dat geen startupinstaller nog oude bron gebruikt en geen actief eigen governanceblok overblijft. De 229-byte shim is uitsluitend compatibiliteit voor een oud expliciet pad; de nieuwe installer registreert hem niet.
6. Native hooktrust blijft een native gebruikerskeuze. Herstart de gekozen sessie/daemon volgens de hostprocedure en verifieer identiteit en geregistreerde ontvanger vóór een echte berichtproef. Issue 718 blijft apart open; neem een groen fixturebewijs niet als bewijs voor cachegeldigheid in bestaande sessies.
7. Houd de WebAuthn-runner, passkeys, ACL/eigenaarscontroles en LaunchAgent intact. De nieuwe runnerinstaller beheert geen oude vaste mergewrapper; eventuele verwijdering daarvan is apart werk.

Een installatierun voert geen inboxmigratie, heldherstel of live boodschap uit. De regressietest voor upgrades bewaakt dat het eigen oude governanceblok verdwijnt, statuscode wordt vervangen, native instellingen en trust blijven staan en heldpost ongewijzigd blijft.

## Herstel van historische heldpost

Maak eerst een private snapshot van de gekozen ontvangersbestanden en bevestig het juiste `LAB_LEAD_STAAT`. Inspecteer alleen aantallen indien inhoud niet nodig is:

```sh
bun scripts/lead/peers/cli.ts vasthouden <ontvanger> --aantal
```

Een geregistreerde sessie met `LAB_AGENT_NAAM=<ontvanger>` kan, ongeacht haar roletiket, haar eigen oude enveloppen met `vasthouden <ontvanger>` bekijken. Een lokale operator zonder sessie-identiteit kiest de ontvanger expliciet. Herstel vervolgens alleen gekozen IDs of, bewust, alle post van die ene ontvanger:

```sh
bun scripts/lead/peers/cli.ts vrijgeven <ontvanger> <id1> <id2>
bun scripts/lead/peers/cli.ts vrijgeven <ontvanger> --alle
```

Zonder IDs of `--alle` verandert niets. Herhalen is veilig: alleen nieuwe inboxpublicaties tellen mee. Een onderbreking na inboxpublicatie levert bij een volgende poging geen duplicaat op. Vreemde, onleesbare of ongeldige historische regels blijven bewaard voor gericht onderzoek. De uitkomst noemt alleen het aantal en de ontvanger, geen inhoud. Een echte herstelactie kan de gekozen ontvanger wekken; daarom is zij niet tijdens deze opdracht uitgevoerd.

## Rollback

Revert de bronpatch via een normale review. Instellingen en geïnstalleerde kopieën vereisen hun eigen vooraf vastgelegde backups; een Git-revert zet ze niet terug. Zet herstelde berichten niet blind opnieuw in de heldmap: bewaak IDs en ackstatus. Deze worker heeft geen live herstel uitgevoerd en heeft dus geen live datarollback nodig.
