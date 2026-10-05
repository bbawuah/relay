<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Regels voor agents en wat ze afdwingt

Een correctie aan een agent landt op de hoogste trede die past, in deze volgorde:

1. **Architectuur**: de fout is onmogelijk (geen toegang, geen pad, verkeerde vorm compileert niet).
2. **Poort**: een stap in `scripts/poort.ts`, een lintregel of een test die rood wordt.
3. **AGENTS.md**: een regel hier, met in de tabel wat hem afdwingt.
4. **Review**: de lead ziet het bij de merge.

**Drempel:** een soort fout krijgt een check zodra dezelfde oorzaak twee keer is gezien.

Elke rij hieronder is nagelopen in de code (5 okt 2026), niet aangenomen. "Niets" betekent dat alleen de opdracht en de review de regel bewaken; de zin erna noemt de trede die hij zou kunnen worden.

| Regel | Afgedwongen door | Waar |
|---|---|---|
| Alles via een PR naar `main`; geen direct push, force-push of delete van `main` | GitHub-ruleset "main beschermen" (actief, geen bypass): `pull_request`, `non_fast_forward`, `deletion` | GitHub, ruleset 24490254 |
| Een PR naar `main` merget pas met een groene poort | Ruleset: verplichte status-check `poort` (= `bun run check --ci`, zonder e2e) | ruleset 24490254; `.github/workflows/ci.yml` |
| Niemand pusht met een rode poort | Pre-push-hook draait `bun run check`. Omzeilbaar met `POORT_OVERSLAAN=1` of `--no-verify`; `core.hooksPath` staat in de gedeelde repo-config, dus per clone | `.githooks/pre-push` |
| Alleen de lead merget; agents openen alleen een PR | Niets: de ruleset vraagt 0 reviews, dus wie `gh` heeft kan mergen zodra de check groen is | Trede: een required review in de ruleset, of een CODEOWNERS met de lead |
| Elke import heeft een gedeclareerde dependency; geen versiedrift tussen workspaces | Poortstappen `boundaries` (turbo boundaries) en `sherif`, met een baseline die alleen krimpt | `scripts/poort.ts`, `scripts/poort-baseline.json` |
| Bekende schuld mag alleen krimpen | Poort: een nieuwe schending is FOUT, een opgeloste die nog in de baseline staat ook ("haal weg") | `scripts/poort.ts` (stappen sherif, boundaries, ds-regels) |
| De DS-norm in de apps: geen kaart als sectie, geen sectievlak, geen grote radius, geen schaduw op wat niet zweeft, tokens i.p.v. arbitraire tekstwaarden | Poortstap `ds-regels` (R1–R5, R7) op git-getrackte bestanden, met baseline en een allowlist met reden | `scripts/ds-regels.ts` |
| DS niet aanpassen vanuit een app (geen eigen tokens of `cn-*`-stijlen in app-CSS; een DS-wijziging gaat via `packages/*` in een eigen PR) | Gedeeltelijk: `ds-regels` R7 vangt alleen een eigen `border-radius` in app-CSS. Niets houdt een app tegen die `.cn-*`-klassen overschrijft (dat gebeurt nu in `apps/vault-b/app/globals.css:48-75`) of een app-PR die `packages/*` wijzigt | Trede: een ds-regels-regel R8 "`.cn-*` of een DS-token herdefiniëren in app-CSS", met baseline; en een poortstap die PR's met zowel `apps/*` als `packages/*` meldt |
| Kleurparen halen AA in beide thema's | Tokens-build faalt bij een paar onder de drempel (`contrast.ts` → exit 1) | `packages/tokens/scripts/contrast.ts` |
| Geen nieuwe toegankelijkheidsfout in de DS-componenten | Storybook-axe over alle stories × licht/donker, met baseline; alleen in de e2e op de mini, niet in CI | `apps/storybook/scripts/a11y.ts`, `a11y-baseline.json` |
| Stiltevenster 05:00–07:15: geen zware runs, herstarts of uitrol | Gedeeltelijk: de e2e-stap van de poort is FOUT in het venster; `uitrollen.sh` van tmux, Vault-B en watchparty, `klaarover-sleutel.sh` en `test-watchparty.ts` weigeren. Niets houdt een losse build, shots of `bun run` van een agent tegen | `scripts/poort.ts` (`inStiltevenster`); `apps/*/scripts/uitrollen.sh`, `apps/watchparty/deploy/uitrollen.sh`. Trede: een gedeelde `scripts/stiltevenster.ts` die elke zware scriptstap (build, shots, e2e) aanroept |
| Eén volledige poort tegelijk op de machine | Gedeeltelijk: alleen de watchparty-e2e neemt een machinebrede lock; `poort.ts` zelf heeft geen lock | `apps/watchparty/scripts/e2e-lock.ts`. Trede: dezelfde lock om de e2e-stap van `poort.ts` |
| Testen alleen op een wegwerp-tmux (`-L <naam>`, `-f /dev/null`, zonder `TMUX`/`TMUX_PANE`) | Gedeeltelijk: de tmux-e2e weigert een socketnaam zonder `tmuxtest-`; de server en de servertests gebruiken `TMUX_PWA_SOCKET`. Niets voor losse scripts of commando's van een agent | `apps/tmux/test/e2e.ts:36`, `apps/tmux/server/tmux.ts:12`. Trede: een gedeelde tmux-helper voor scripts die zonder `-L` weigert |
| Tests nooit op live poorten (8220, 8230, 8260, 8448 …) | Gedeeltelijk: de watchparty-harnas weigert een lijst verboden poorten; de andere apps kiezen een vrije poort maar controleren het niet | `apps/watchparty/test/e2e/harnas.ts:54` |
| Watchparty: geen `<all_urls>`, geen remote code, alleen `watch.lab-b.dev` | `controleer:productie` keurt het gebouwde manifest en de bestanden af (met tests) | `apps/watchparty/scripts/controleer-productie.ts` |
| Watchparty: Netflix nooit via `video.currentTime`/`playbackRate`, alleen via de bridge | Statische test op de bron | `apps/watchparty/src/spelers/netflix-statisch.test.ts` |
| Watchparty: het protocol en de cryptografie zijn bevroren | Vaste testvectoren; een wijziging maakt de test rood | `apps/watchparty/shared/crypto.test.ts`, `rtc.test.ts` |
| Watchparty: nooit video, beeld of audio opnemen (`captureStream`, `getDisplayMedia`) | Niets | Trede: dezelfde statische test als voor `currentTime` |
| Watchparty: werk alleen in `apps/watchparty/` (plus `bun.lock` op verzoek) | Niets | Trede: een poortstap die per app-PR de geraakte paden toetst aan de toegestane map |
| Niets naar buiten zonder akkoord (berichten, publiceren, DNS, uitrol) | Niets in de repo. Alleen de veiligheidscheck van Claude Code weigert soms een actie (zoals het DNS-record via de vercel-CLI op 4 okt); dat is geen check van ons | Trede: architectuur, met uitgaande acties alleen via een script dat een akkoordbestand of -vlag van Brian vraagt |
| Geen sleutels lezen, ook geen namen | Niets | Trede: architectuur (bestandsrechten of een aparte gebruiker voor de sleutelbestanden) |
| Uitrol alleen door de lead of Brian | Niets in de repo; de uitrolscripts controleren niet wie ze draait. De Claude Code-veiligheidscheck weigert uitrol meestal | Trede: een akkoordvlag in `uitrollen.sh` |
| Nooit andermans worktrees of takken aanraken; eigen alleen als gemerged én schoon | Gedeeltelijk: `git worktree remove` zonder `--force` weigert bij onbewaard werk; git weigert een uitgecheckte tak te verwijderen. Verder niets | Trede: een opruimscript dat alleen namen uit het eigen rapport verwijdert |
| Een wijziging in `packages/*` krijgt shots vóór en na, en Brians akkoord | Niets | Trede: een poortstap die bij `packages/*` een shots-rapport in de PR-body eist |
| PR-titel `<gebied>: …` in het Nederlands, body met wat/waarom/poortuitslag en de Claude Code-attributie | Niets | Trede: een CI-check op titel en body |
