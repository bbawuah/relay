# Sub-lead (concept voor ~/.claude/skills/lead/references/sublead.md)

Een sub-lead is een sessie die een reeks taken uit haar eigen contract zelf rondt (bouw, review, herstel) en de lead alleen de uitkomst meldt. Zo groeit de context van de lead met één korte regel per taak, niet met elk rapport.
Start: `scripts/lead/spawn.sh --sublead --naam <n> --opdracht <contract> --lead <lead>`.

## Stappenplan (Agent-tool, standaard)
1. Lees het contract en de vaste grenzen (CONTRACT.md). Zet de taken in een lijst met per taak: id, tak, opdracht (bezit-bestanden erbij) en of de diff zwaar is (zie 3).
2. Bouwen: per taak één bouwer (`Agent`, `model: sonnet`, `isolation: worktree`), taken zonder gedeelde bestanden parallel. De prompt bevat de taakopdracht, de grenzen en: Edit boven python-replace, tests die git aanroepen gebruiken `schoneEnv()`, geen volledige poort met e2e, PR-body volgens `.github/pull_request_template.md`. De bouwer geeft terug: tak, PR, sha, testuitslag, open punten.
3. Review: per PR één reviewer die niet plant (`Agent`, alleen lezen, `model: sonnet`; `opus` als de diff `packages/*`, passkey, de schrijfcheck of serverroutes raakt). Toetst `gh pr diff` aan AGENTS.md, de taak en de bezit-lijst (`merge.sh --contract <bestand> --spoor <id> --droog` toont bestanden buiten het bezit). Geeft blokkerende en niet-blokkerende punten en een oordeel (akkoord of wijzigingen).
4. Herstel: bij blokkerende punten hooguit één herstelronde (verse bouwer op dezelfde tak), daarna een herreview. Blijft het blokkerend: meld het zo, de lead beslist.
5. Zichtbare wijziging: `bun run bekijk` draait de bouwer niet zelf met foto's in de eigen context. Een sonnet-subagent bekijkt de foto's en meldt alleen een oordeel (maten, contrast, zichtbare knoppen, consolefouten). Bouwers lezen schermfoto's niet zelf in (retro tmux-header #2).
6. Lange taken: wordt een bouwer groot (rond 200k context), commit en start een verse sessie met `spawn.sh --vervolg <tak>`: die leest alleen de OPDRACHT en `git log`/diff van de tak (retro #1).

## Melding aan de lead
Per taak één regel: `<id>: PR #<n>, <sha7>, review <akkoord|wijzigingen>, open: <punten of geen>`. Geen samenvattingen, geen diffs, geen foto's. De lead geeft akkoord en merget (via `wachtrij.ts`/`merge.sh`); de sub-lead merget nooit en voert geen volledige poort met e2e uit.

## Grenzen
Alles uit "Vaste grenzen" geldt voor de sub-lead en voor elke bouwer en reviewer die zij start: eigen tak en worktree, alleen het bezit van het spoor, geen sleutels, geen echte tmux of live poorten. Een sub-lead start geen nieuwe sessies met `spawn.sh`; dat doet de lead.

## Workflow (alleen met toestemming)
`scripts/lead/vaste-cyclus.js` voert dezelfde cyclus als workflow uit (`args.taken`: id, tak, opdracht, zwaar). De Workflow-tool draait alleen als Brian daarvoor toestemming gaf; de startzin noemt dat letterlijk ("Brian gaf op <datum> toestemming voor workflows (zie ~/vault-b-status/lead.md)"), en dat gebeurt alleen met `spawn.sh --sublead --workflow <datum>`. Zonder die zin: Agent-tool.
