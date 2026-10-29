# Verification handoff

29 October 2026, branch `feat/standalone-peerbus`.

Completed locally:

```sh
bun install --ignore-scripts
bun test ./tests/relay.test.ts ./tests/codex-state.test.ts ./scripts/lead/peers/server.test.ts ./scripts/lead/hooks/codex-installeer.test.ts ./scripts/lead/installeer-hooks.test.ts ./scripts/lead/beleid/beleid.test.ts
bun run typecheck
git diff --check
```

Result: **118 tests passed, zero failed**, TypeScript passed, whitespace check passed.

The installed-copy checks use temporary HOME, state and installation prefixes, including paths with spaces and quotes. They cover CLI-to-MCP delivery/acknowledgement, held messages and operator restrictions, duplicate-name/path rejection, update/uninstall, refusal to overwrite unmanaged files, Claude per-session hooks, Codex hook setup/trust/state, session cleanup after a simulated CLI crash, and Git status in a consuming project. Vendor CLIs/app-server responses are fakes; no live agent or user configuration was exercised.

Still required before pushing:

```sh
bun run poort
```

The full inherited suite includes tmux/end-to-end checks and was deferred because the source repository's 05:00–07:15 Europe/Amsterdam quiet window was active. Run it after 07:15 on 29 October 2026. This handoff does not claim a green full gate or real-vendor end-to-end verification.

GitHub `bbawuah/relay` was empty when inspected. No remote refs, repository settings, PRs, global hooks, live state or source-monorepo files were changed. Its initial default branch must be established before a normal PR can be opened; no direct push to `main` was performed.
