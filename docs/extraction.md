# Historical extraction inventory

This document records the pre-0.2.0 extraction, not the current delivered runtime.
In 0.2.0 the policy, hook, orchestration, personal-skill and old bus destinations
below were deliberately retired. Their source remains in Git. The manifest keeps
each original source/hash/category with `formerDestination`, `disposition`, reason
and retirement version; `extractionUnchanged` preserves the earlier observation.
Current installation and verification are described in [README](../README.md),
[configuration](configuration.md), [test retirement](test-retirement.md) and
[verification](verification.md). Removing source never uninstalls project or
harness safeguards.

The remainder is historical evidence of the extraction and its then-current tests.

Source: `bbawuah/LAB-BAWUAH`, commit `10173799bedfbd712551025301e80925385217cb` (29 October 2026).

Relay builds on the existing local, history-filtered extraction at `6c9bbd12782761da20ced5cc090527711473f8b2`. Its history and portability fixes are retained. The source monorepo and the other local Relay worktrees were not changed. The current Codex-lead MCP identity fix and boundary-hook wording were synchronized from the source.

The complete file-by-file inventory is [source-manifest.json](source-manifest.json): source path, destination, category, source SHA-256 and whether the file was unchanged when the extraction inventory was recorded. All 137 files under `scripts/lead/` and `agents/skills/` are accounted for, including archived product tests.

| Layer | Source | Files | Treatment |
| --- | --- | --- | --- |
| Peerbus | `scripts/lead/peers/` | 22 | Bus, frozen contract, names, UUIDs, CLI, MCP, wake-up routes, unit tests and disposable end-to-end demos preserved |
| Host hooks | `scripts/lead/hooks/` | 40 | Session register, external-origin propagation, Claude/Codex adapters, per-checkout identity, Codex trust API, installed-file handling, status, fixtures and tests preserved |
| Policy | `scripts/lead/beleid/` | 13 | Policy schema/source, host mappings, Claude generator, Codex worker profile and skill installer preserved |
| Legacy orchestration | Remaining `scripts/lead/` | 52 | Launch/spawn, rename, hardened Git, merge/push queue, command runner and existing split prototype retained as legacy source |
| Skills | `agents/skills/` | 10 | Lead, retrospective and design-interview instructions plus references/scripts retained; not enabled globally by installation |

Additional root helpers (`test-integriteit.ts`, `stiltevenster.ts`, `scripts-tests-veilig.ts`, `poort.ts`) were retained by the earlier extraction. The independent Relay package, installer, `src/` entrypoints, documentation and installation tests supply the standalone user interface.

## Dependencies checked

- The live peerbus statically depends on the register and Codex identity adapter, not just files in `peers/`. All are included.
- `hook.ts` and `codex-wrap.ts` dynamically load the peerbus/name adapter. Both repository layout and flattened installed-hook layout are retained.
- Hook installers copy a second `hooks/register.ts` alongside `peers/`; `peers-kopie.ts` records that dependency. The existing installer tests exercise the installed layout.
- Claude hook generation depends on `beleid/`; Codex installation depends on `codex-appserver.ts`, `peers-kopie.ts` and the shared Bun-path helper. These ship together.
- Runtime needs Bun and its built-in Node-compatible APIs. No runtime workspace package, package-manager hoisting or monorepo `node_modules` is required.
- External executables are capability-specific: Claude/Codex for launching, `codex queue` or `t3` for wake-ups, Python for the retained Codex boundary hook, and tmux/Git/jq/Python for the full legacy test suite.
- Whole-repository reference searches found peerbus integrations within `scripts/lead/`; unrelated Watchparty and GoldCoast files also named `relay` are product networking/database code and were not extracted.

## Changes for standalone use

- `bin/relay.ts` and `src/` provide a stable command for messaging, MCP, manual registration, session launch, diagnostics, setup and uninstall.
- Installation copies the runtime and writes a launcher with absolute Bun/runtime paths. It does not depend on the checkout remaining at its original path.
- `RELAY_*` settings map to the original `LAB_*` interface. The wire format and server name `peers` are unchanged. Relay uses separate state by default; joining the old bus is explicit.
- Codex hook setup embeds the selected state directory in each hook command. The launcher checks trust and state before writing a checkout identity.
- Claude sessions get hooks and MCP per invocation. Codex sessions retain vendor policy and use their configured, trusted hooks.

## Product-specific source retained separately from the supported interface

The former extraction already moved seven product tests to `tests-uitgesloten/*.txt`; their original paths and reasons are in `TESTS-UITGESLOTEN.md`. Their production counterparts remain for provenance but are not Relay entrypoints: the tmux decision integration, WebAuthn command runner, MOD read helper and monorepo-specific merge/release machinery require their original product context. `relay.toml` remains a design example, not a claim that those workflows are configurable today.

The inherited quiet-window policy, protected merge scripts, personal home paths in historical instructions and source fixtures are preserved as legacy context. The installer does not activate personal skills, deploy services or replace the original monorepo tooling. A later monorepo migration should update callers only after Relay's standalone verification and installation are accepted.

## Verification scope

The new installation tests run a copied Relay executable with temporary HOME/state, send a message through the CLI, read and acknowledge it through a real stdio MCP process, check held-message policy, and exercise update/uninstall and collision handling. Launch-plan tests check per-session hooks/MCP and absence of automatic permission bypass. Existing peerbus, hooks and installer tests remain part of `bun run poort`.

No live Claude/Codex/T3 session, private registry, default tmux server or existing global hook settings are needed for those checks. The real-Codex demo is separately opt-in. Verification status and any deferred full-gate run are reported with the extraction handoff rather than implied by this inventory.
