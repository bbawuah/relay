# Verification handoff

## Message package 0.2.0 — E focused verification

29 October 2026, `feat/message-package`, T3-bound worktree
`/Users/labbawuah/.t3/worktrees/relay/feat-message-package`. Start baseline
`567767912dd6d9845d20f279e25f0f51e6cece40`; explicit B2
`797bf059c26c1a4944b0bb369cf86b07ec6f5581` and D
`721e5211b34ce637087203dc71a64fd54bbd755e` cherry-picks provide the neighboring
store/dispatcher and CLI/MCP. E does not modify their files.

The first focused package/startup run produced **30 pass / 23 fail** because E's
new `Bun.Transpiler.scanImports` call rejected the executable polyglot shebang.
The repair removes the first shebang line before scanning; imports in the entry
and all runtime source remain checked. Initial evidence is retained at
`/tmp/relay-e-package.EA3cbU/tests.log`.

The first repaired run passed **53 tests, zero failed, 1,496 assertions** across
`message-package.test.ts`, `relay.test.ts` and `runtime-safety.test.ts`.
Evidence: `/tmp/relay-e-package.WfevjE/tests.log`. It covers the actual installed
CLI/MCP, keyed send retry, non-destructive reads and explicit ack, repeatable
install, state-preserving uninstall, source/foreign/symlink refusal, package-bin
and installed/startup config/preload/dotenv/tsconfig isolation, stable Bun fallback,
provenance and self-uninstall regression cases. Boundary mutation fixtures are
separate inert module graphs and never substitute for the actual CLI smoke.

The final strengthened run passed **54 tests, zero failed, 2,167 assertions**
(`/tmp/relay-e-final.hnq6C9/tests.log`). It additionally proves that the polyglot
entry still rejects an injected retired import and compares every retired
manifest source/hash/category/former destination to the committed baseline.
CI fetches that history explicitly so these provenance checks cannot silently
skip in a shallow checkout.

Local dependencies were prepared with frozen lockfile and ignored scripts under
temporary HOME/cache. The initial typecheck lacked local Bun type definitions;
it is not counted as a pass. The package now invokes the local TypeScript compiler
through Bun rather than a global Node shim. Repaired `bun run typecheck` passed
(`/tmp/relay-e-types.9kQ1Ct/typecheck.log`); `bun run check:package` passed with
20 runtime files and no retired imports (`/tmp/relay-e-boundary.SY6fpu/boundary.log`).
The package privacy flag, dependencies and lockfile are unchanged.

No full gate, live-state installation, provider settings, live host tests, push,
merge or publishing was performed. T3 remains polling; F's importer and migration
guide are a separate pending integration. macOS is the worker platform; Linux and
the complete reduced gate remain for the lead/CI. The known Bun 1.4.2 `/dev/null`
directory-mismatch diagnostic remains visible in test logs.

## Historical extraction verification

Everything below concerns the former orchestration/peerbus extraction, its source
commits and its old gate. It is preserved as historical evidence, not a claim that
the removed product behaviors ship in 0.2.0 or that the current full gate ran.

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

A new independent Opus review of combined candidate `e23a5bd` found no new medium or high issue and accepted the preceding repairs. Its own archived-copy run passed **71 tests with zero failures**. SQLite recovery after a crash during commit page writes remains unproven and was classified as a low, non-blocking uncertainty. D3's bounded pre-commit crash fixture reopened successfully, but did not produce the suspected hot-journal/raw-database failure. This is not a recovery-fix claim. Real vendors, interactive PTYs and Linux remain separate verification limits.

## Complete local gate

```sh
bun run poort
```

The full inherited gate ran on `caf62d5b31ccf14b9c45fc5a6b79bd0809f1b343` at 07:15 on 29 October 2026, after the Amsterdam quiet window, with isolated HOME/TMPDIR and no inherited session identity. Result: **1,521 passed, 1 skipped, zero failed**, 11,263 assertions across 46 files, followed by a successful TypeScript check and hook-file checks. The tests took approximately 260 seconds. The complete output is retained locally in a private log and is not published.

The skipped test requires a real Codex CLI and the opt-in `RELAY_E2E_CODEX=1`; it was intentionally not enabled. The default suite includes disposable tmux/end-to-end checks and fake vendors. It does not establish real Claude/Codex/T3 or interactive PTY compatibility. Linux is covered separately by the included GitHub Actions workflow.

GitHub `bbawuah/relay` was empty when inspected, with no base branch for a normal PR. The initial reviewed import targets `feat/standalone-peerbus`; no direct push to `main`, global hook installation, live-state change or source-monorepo migration is part of this extraction.
