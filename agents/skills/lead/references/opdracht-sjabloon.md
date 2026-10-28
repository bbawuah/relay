# Sjablonen: plan, contract en opdracht

Meerdere sporen: eerst `PLAN.md`, dan `CONTRACT.md`, dan per sessie een kort bericht.
Eén losse taak: alleen `OPDRACHT.md`.

## PLAN.md (technisch plan)

```markdown
# Plan: <product of feature> (lead: <naam>, <datum>)

## Doel
<wat het oplevert voor Brian; wat expliciet niet>

## Architectuur
<onderdelen, waar ze draaien, hoe ze samenhangen>

## Interfaces
<per grens tussen sporen: types/schema's, routes, berichten, bestandsformaten; exact, want het
contract verwijst hiernaar>

## Fasering
| Fase | Inhoud | Sporen | Klaar als |

## Risico's
<wat live raakt, privacy, geheugen op de mini, afhankelijkheden>

## Beslissingen voor Brian
1. <vraag> — voorstel: <...>
```

## CONTRACT.md (per spoor, afgeleid uit het plan)

```markdown
# Contract: <product> (lead: <naam>, <datum>; plan: <pad>)

Vaste grenzen voor elk spoor: wegwerp-testomgeving, geen sleutels, niet mergen/uitrollen/naar main
pushen, volledige poort alleen na seintje, stiltevenster, nooit andermans worktrees.
Merge-volgorde: <A → B → C>.

## Spoor A: <naam>
- Eigenaar: <sessie of agent> · tak: <naam>
- Wacht op: <sporen/PR's die eerst gemerged moeten zijn, of —>
- Bezit: <bestanden/mappen>. Niet aanraken: <...>
- Levert: <interface uit het plan>. Gebruikt: <...>
- Klaar als: <tests, poortstappen, wat er in de PR staat>
- Afronding: na de merge eigen worktrees, lokale takken en scratch opruimen; rapport noemt wat er weg is.

## Spoor B: ...
```

Laat elke sessie bevestigen dat ze plan en contract heeft gelezen voordat ze begint. Een wijziging
aan het contract loopt via de lead en wordt opnieuw bevestigd door wie het raakt.

---

# Opdracht-sjabloon

Schrijf de opdracht naar `~/vault-b-status/<onderwerp>/OPDRACHT.md` vóór je het bericht stuurt.
Een agent leest het bestand; jij kunt er na een compactie naar terugwijzen.

```markdown
# Opdracht: <onderwerp> — sessie/agent <naam> (lead: <jouw sessienaam>, <datum>)

Aanleiding: <waarom; met bron: incident, onderzoek, Brians woorden letterlijk>.
Lees eerst: <plannen, contracten, eerdere verslagen; met paden>.
Je mag subagents inzetten (<worktree of niet>); jij reviewt hun werk.   ← alleen bij een sub-lead

## Doel
<concreet resultaat, in stappen of PR's; per stap wat "klaar" is>

## Grenzen
- Testen alleen in een wegwerpomgeving (eigen -L-socket, vrije poort, tijdelijke paden).
- Geen sleutels lezen; niet mergen, niet uitrollen, niet naar main pushen.
- Zoeken (grep/rg, ook via subagents) sluit sleutelbestanden uit: `--exclude=config.properties --exclude=config.json --exclude='.env*'` (19 okt: een brede grep van een subagent raakte config.properties-regels).
- Alleen deze bestanden: <lijst>. Niet: <wat een ander spoor bezit>.
- Volledige poort alleen na seintje van de lead. Stiltevenster 05:00–07:15.
- Nooit andermans worktrees aanraken.

## Overdracht
Klaar als: <een controle die een ander kan draaien: poort groen + PR open, of "Brian ziet X op de telefoon">
Stop als: <een bevroren bestand moet wijzigen | een check faalt twee keer | je wacht > 20 min | je mist een tool of recht>
Meld aan: de lead via SendMessage; lukt dat niet, schrijf `~/vault-b-status/<onderwerp>/STATUS.md`.
Start in: <map> · Nodig: <tools/MCP-servers>. Eerste stap: controleer dat ze er zijn; zo niet, meteen melden en stoppen.
Gegevens die je meekrijgt (elk stuk met bron en status, sleutels precies zoals de volgende stap ze vraagt):
- <bron, bv. video:> <waarde of pad> (geverifieerd | gemeld | aanname)
- <sleutel uit het schema, bv. `audio`> = <waarde>
Terugleesstap: je eerste bericht aan de lead herhaalt in 3 regels wat je gaat doen, wat klaar is en
wat je aanneemt; bij een groot spoor wacht je op "ok" (I-PASS: 23% minder fouten bij overdracht in ziekenhuizen).

## Oplevering
<bestand(en) of PR>, rapport aan de lead van max ~15 regels: status (klaar | deels | geblokkeerd),
tak, commits, wat werkt met bewijs, testuitslag, wat Brian moet doen, open punten, absoluut worktree-pad.
Lange uitkomsten in een bestand onder `~/vault-b-status/<onderwerp>/`; het bericht noemt alleen het pad.
De PR-body volgt `.github/pull_request_template.md`: Samenvatting, Bewijs en Merge-gevaar
(eenrichting of tweerichting, data/instellingen/live diensten, blast radius). De lead kiest
daarmee de reviewdiepte.

## Afronding
Na de merge: je eigen worktrees, lokale takken (ook die van je subagents), testmappen en
scratch opruimen; eerst controleren dat alles gemerged en schoon is (ongetrackt telt mee),
`git worktree remove` zonder --force. Meld wat er weg is en dat je vrij bent.
```

## Het bericht (SendMessage)

Kort, met de kern en een verwijzing:

> Lead: nieuw werk, op verzoek van Brian. <één of twee zinnen doel>. De volledige opdracht
> staat in <pad>; lees die eerst. <de één of twee belangrijkste grenzen>. Je mag subagents
> inzetten. Stuur me <wat> en een TL;DR van max N regels.

## Voor subagents (Agent-tool)

Dezelfde inhoud, maar als volledige prompt: een subagent heeft jouw context niet. Noem paden,
regels, wat klaar betekent, en sluit af met het rapportformaat. De vijf regels uit "Overdracht"
gaan altijd mee, ook in een korte prompt.

Waarom (27 okt, MEGA S01E02): een record zonder bronlabels liet de volgende sessie de volgorde
raden (één afgewezen claim), receipts onder eigen namen in plaats van de sleutels uit het
schema werden geweigerd, en een sessie in een submap miste de MCP-server die alleen voor
`~/Desktop/LAB-BAWUAH` is ingesteld. Tekst alleen draagt de herkomst niet; de brief moet het doen. Gebruik `isolation: "worktree"`
voor bouwwerk; laat de subagent zelf een tak met een betekenisvolle naam maken.

## Onderzoek

Splits een brede vraag in sporen (A, B, C) over idle sessies, elk met één vraag en een eigen
verslagbestand. Eis bronnen met URL en datum, of "(inschatting)". Controleer zelf de twee of
drie claims die het meest gewicht dragen voordat je ze in een synthese zet, en noem je
correcties.
