# Broncheckpoint en onafhankelijke reviews

Geteste en definitief gereviewde runtimebron: **`9550c094af8db00cb8b2518c3f09cd3a30e75af8`**. Basis: `003773bfda5b913e2698562cb9805c1a31720374`. Latere bewijsartefacten wijzigen uitsluitend documentatie en captures; geen runtime- of testbron.

Beide reviews draaiden als verse, appgebonden, geïsoleerde Codex-taken met `gpt-6.1-sol`, `reasoningEffort=high`, `serviceTier=default`. Geen Claude, model-runtimeoproepen, live berichten, installatie of herstel. Reviewers wijzigden geen bron.

## Eerste ronde

SHA `c13a599b083d8a11950a8853c32aa8767c3fd9c0`; eigen worktree `t3-fd0b062d`. Task-id: `node:delegated-task:command%3Amcp%3A3e783700-9d9c-408e-bad5-c6a07c74845d%3Adelegate-task%3Aremove-agent-policy-review-c13a599-round1`.

Vijf reproduceerbare bevindingen, alle verwerkt in `9550c09`:

1. P1: een malformed heldregel met geselecteerd ID werd opgeruimd. Pruning vereist nu een valide geselecteerde envelop; de ongeldige regel blijft byte-voor-byte staan.
2. P1: een corrupte inboxregel met alleen het ID kon geldige heldpost verliezen. Tegenstrijdige inhoud stopt nu vóór publicatie/pruning, zonder inhoud in de CLI-fout.
3. P2: een oude `LAB_BELEID_ID=grenzen`-entry bleef geregistreerd. Installatie en verwijdering herkennen nu exact die eigen legacy marker; native hooks, andere markers en permissions blijven behouden.
4. P2: `lead-proef` verloor bestaande workerstatus. De statusroutering is hersteld; het label, de binding/lifecycle en het ontbreken van Stop-blokkades blijven behouden.
5. P2: een geregistreerde parent met rol `reviewer` werd geweigerd. Parentroutering gebruikt nu rolvrije levende sessies en weigert naamambiguïteit. De productgerichte `levendeLeads`-API is niet gewijzigd.

De reviewer draaide 25 gerichte tests plus hermetische reproducties. De worker heeft regressietests voor alle vijf toegevoegd.

## Tweede ronde

SHA `9550c094af8db00cb8b2518c3f09cd3a30e75af8`; eigen worktree `t3-e61de5eb`, branch `t3/review-recovery-fixes`. Task-id: `node:delegated-task:command%3Amcp%3A3e783700-9d9c-408e-bad5-c6a07c74845d%3Adelegate-task%3Aremove-agent-policy-review-9550c09-round2`.

Oordeel: **alle vijf bevindingen opgelost; geen nieuwe blokkerende regressie gevonden binnen de begrensde review**. 36 gerichte testuitvoeringen, nul failures, inclusief parallel herstel, retentie/dedupe, eigenaarschap, identiteitsverval en behouden resourcegrenzen.

## Volledige validatie en bewijs

`bun run poort` op `9550c09`: exit 0, **785 tests geslaagd**, typecheck en hookcanaries. Zie [captured poortsummary](evidence/poort.txt). Dependency-installatie gebruikte de bestaande lockfile met `bun install --frozen-lockfile --ignore-scripts`; er is geen dependency-, vendor- of runtimeupgrade.

De [vóór/na-beelden](evidence/README.md) tonen werkelijk vastgelegde stdout uit wegwerpfixtures. Het na-beeld gebruikt exact `9550c09`, het vóór-beeld exact `003773b`. Het [manifest](evidence/manifest.json) legt bron-SHA's, renderertype en checksums vast.

Live provideruitvoering, geïnstalleerde hooks en echte queue-recovery zijn niet getest of uitgevoerd. Issue 718 blijft afzonderlijk open; deze review claimt geen oplossing van de bestaande MCP-startcache. Root beheert activering en merge volgens [ACTIVERING.md](ACTIVERING.md).
