# Verification handoff

29 October 2026, branch `feat/standalone-peerbus`.

Initial verification on the original extraction (`32f6b79`):

```sh
bun install --ignore-scripts
bun test ./tests/relay.test.ts ./tests/codex-state.test.ts ./scripts/lead/peers/server.test.ts ./scripts/lead/hooks/codex-installeer.test.ts ./scripts/lead/installeer-hooks.test.ts ./scripts/lead/beleid/beleid.test.ts
bun run typecheck
git diff --check
```

Result at that checkpoint: **118 tests passed, zero failed**, TypeScript passed, whitespace check passed. Independent reviews then found additional issues; this initial result is not a release approval.

The installed-copy checks use temporary HOME, state and installation prefixes, including paths with spaces and quotes. They cover CLI-to-MCP delivery/acknowledgement, held messages and operator restrictions, duplicate-name/path rejection, update/uninstall, refusal to overwrite unmanaged files, Claude per-session hooks, Codex hook setup/trust/state, session cleanup after a simulated CLI crash, and Git status in a consuming project. Vendor CLIs/app-server responses are fakes; no live agent or user configuration was exercised.

## Review repairs and integration

- E (`bde174f`): explicit MCP identity with protected lead-proef binding; 59 targeted server/identity tests passed.
- C (`d4133bf`): startup isolation, path canonicalization, self-uninstall and Bun-executable handling; 39 targeted tests passed. The same tests produced 30 failures against its earlier basis.
- D (`11e6478`): default agent roles, reserved flags, PID/start-time owners, crash/concurrency recovery and private SQLite reservations; 54 targeted compatibility/safety tests passed, plus typecheck. Unknown/symlink/hardlink database targets remain unchanged.
- C4 (`3798761`): installation provenance for symlink-prefix self-uninstall; 49 runtime/install tests passed, including 10 regressions that failed against the C basis.
- Lead integration: safe Bun arguments on the per-session MCP path; fixed Claude identity versus live Codex routing; explicit `--name` versus inherited `RELAY_NAME`; stale daemon aliases cannot select another state or inbox. Installed-process tests also cover hostile Bun/tsconfig startup and an owner that has died. Typecheck passed.

An integrated run before C4 passed 96 tests across all six new test files. After the final routing and C4 repairs, the focused runtime/routing run passed 53 tests and the routing/lifecycle run passed 25. These overlap; they are not added together as one suite result. The final independent review and full inherited gate remain separate required checks.

An independent Opus re-review accepted the startup isolation and classified Bun 1.4.2's visible `directory mismatch` stderr message as a known non-blocking runtime limitation. The guard remains enabled and stderr is not suppressed. Its other findings were assigned to the subsequent routing/provenance repairs above; they require final review of the combined commit.

The final reviews of `b720099` found three additional medium issues: the vendor could outlive its launcher and lose its identity, reservation maintenance could abort core hooks, and manual registration could race a launch before SessionStart. D3 (`161441d`, integrated as `e23a5bd`) binds ownership through a trusted, PID-preserving execve bootstrap and separates optional upkeep from core hooks. F (`38cb1a9`, integrated as `dc5ed77`) serializes manual registration with launch reservations. Both reproduced their regressions against the earlier code. The lead's combined installation/routing/lifecycle/hook run passed **86 tests with zero failures**. D3 also verifies one compatible Bun for hooks/MCP/bootstrap and explicitly clears host-forwarded runtime options.

A new independent Opus review of combined candidate `e23a5bd` is in progress. SQLite recovery after a crash during commit page writes remains unproven. D3's bounded pre-commit crash fixture reopened successfully, but did not produce the suspected hot-journal/raw-database failure. This is not a recovery-fix claim. Real vendors, interactive PTYs and Linux remain separate verification limits.

Still required before pushing:

```sh
bun run poort
```

The full inherited suite includes tmux/end-to-end checks and was deferred because the source repository's 05:00–07:15 Europe/Amsterdam quiet window was active. Run it after 07:15 on 29 October 2026. This handoff does not claim a green full gate or real-vendor end-to-end verification.

GitHub `bbawuah/relay` was empty when inspected. No remote refs, repository settings, PRs, global hooks, live state or source-monorepo files were changed. Its initial default branch must be established before a normal PR can be opened; no direct push to `main` was performed.
