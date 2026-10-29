# relay

Deze repository bevat lokale berichtuitwisseling: expliciete peerbindingen,
duurzame mailboxen, retry-receipts en expliciete acknowledgements. Relay start
geen agents en levert geen beleid, providerhooks, Git/merge-tools of skills.
Project- en harnesswaarborgen blijven eigendom van hun eigen project.

Controleer wijzigingen met `bun run poort`. De volledige poort is van de lead;
workers draaien gerichte controles binnen hun opdracht. Houd productintegraties
buiten relay. Historische producttestuitsluitingen staan in
`TESTS-UITGESLOTEN.md`; bewuste scope-retirement staat per bestand in
`docs/test-retirement.md` en claimt geen herstel van die oude gedragingen.

De ondersteunde ingang is `bin/relay.ts` met `src/`. Bewaar de messagecontracten
en de MCP-servernaam `peers`; bronherkomst staat in `docs/source-manifest.json`.
De installer gebruikt een expliciete lijst message-runtimepaden en weigert
imports naar ontbrekende of verwijderde scope.

Installeer of test nooit tegen live state, een live tmux-socket of bestaande
gebruikersinstellingen. Gebruik tijdelijke HOME/state/prefix/cwd en eigen
sockets/poorten. Installeer of verwijder geen globale hooks, configuratie of
project/harnesswaarborgen. Startuptests moeten config/preload/tsconfig-isolatie,
bron- en vreemde-doelweigering, provenance en self-uninstall blijven bewijzen.
