# Test retirement in Relay 0.2.0

These tests are deliberately removed with their retired product scope, not excluded to make a new implementation pass. No old policy, launcher, reservation or hook defect is claimed fixed. Their complete source remains in Git at baseline `567767912dd6d9845d20f279e25f0f51e6cece40`. This source retirement does not uninstall any project or harness safeguard.

| Removed file | Scope reason |
| --- | --- |
| `agents/skills/retro/scripts/test_sessie_samenvatting.py` | Retires the personal retrospective skill and its summarizer; skills are outside the messaging product. |
| `scripts/lead/beleid/beleid.test.ts` | Retires policy generation, permission presets and personal skill installation (beleid.test.ts); project/harness safeguards remain installed. |
| `scripts/lead/beleid/codex-werker.test.ts` | Retires policy generation, permission presets and personal skill installation (codex-werker.test.ts); project/harness safeguards remain installed. |
| `scripts/lead/beleid/skills.test.ts` | Retires policy generation, permission presets and personal skill installation (skills.test.ts); project/harness safeguards remain installed. |
| `scripts/lead/git-hard.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by git-hard.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/hernoem.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by hernoem.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/hooks/codex-adapter.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (codex-adapter.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/hooks/codex-appserver.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (codex-appserver.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/hooks/codex-installeer.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (codex-installeer.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/hooks/codex-wrap.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (codex-wrap.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/hooks/grenzen.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (grenzen.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/hooks/hook-bus.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (hook-bus.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/hooks/hook.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (hook.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/hooks/installatie.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (installatie.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/hooks/status.test.ts` | Retires legacy vendor hooks, implicit checkout identity and hook installation (status.test.ts); explicit message bindings replace this product surface. |
| `scripts/lead/installeer-grens.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by installeer-grens.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/installeer-hooks.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by installeer-hooks.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/lab-lees.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by lab-lees.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/lead-codex.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by lead-codex.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/lead.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by lead.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/peers/afgeleide-naam.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (afgeleide-naam.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/peers/bus.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (bus.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/peers/cli.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (cli.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/peers/e2e/codex-demo.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (codex-demo.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/peers/e2e/demo.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (demo.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/peers/server.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (server.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/peers/types.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (types.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/peers/uuid.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (uuid.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/peers/wekker.test.ts` | Retires the legacy register/policy-coupled bus, wake-up route or vendor demo (wekker.test.ts); new message/service/storage/adapter and CLI/MCP suites cover the message protocol. |
| `scripts/lead/push-werker.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by push-werker.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/push.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by push.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/relay.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by relay.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/relay/g-split.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by g-split.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/spawn-crash.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by spawn-crash.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/spawn-vertrouwen.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by spawn-vertrouwen.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/tmux/vendor.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by vendor.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/vaste-cyclus.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by vaste-cyclus.test.ts; Relay now provides mailbox operations only. |
| `scripts/lead/wachtrij.test.ts` | Retires the orchestration, spawn, Git, merge/queue or product helper tested by wachtrij.test.ts; Relay now provides mailbox operations only. |
| `tests/codex-state.test.ts` | Generated vendor hook settings and policy pinning are retired. Explicit peer/state CLI bindings are covered by message CLI/MCP tests. |
| `tests/hook-canaries.sh` | Checks installed policy/approval hooks and their syntax. Relay no longer ships or installs vendor hooks; startup entrypoint isolation remains tested. |
| `tests/integration-routing.test.ts` | Vendor launch plans, implicit checkout identity and launcher MCP configuration are retired. Explicit connection identity belongs to the new CLI/MCP tests. |
| `tests/launch-safety.test.ts` | Agent launching, permission flags, process ownership and the separate launch-reservation database are retired. Message-store filesystem/recovery safety is tested separately in message-storage.test.ts; no reservation recovery fix is claimed. |
| `tests/manual-registration.test.ts` | Manual versus launched-agent reservation races and legacy name claims are retired. The new directory tests cover explicit mailbox registration and rebinding. |
| `tests/mcp-identity.test.ts` | Legacy name, role and protected-proeflead/checkout inference are retired. Stable peer-bound MCP and foreign ack are covered by the new message MCP tests. |
| `tests/session-survival.test.ts` | Vendor execve bootstrap, launcher lease upkeep and delayed legacy identity replacement are retired. Relay no longer starts or owns vendor processes. |
| `tests/structuur.test.ts` | Required the presence of retired governance hooks. The package boundary now requires their absence in message-package.test.ts. |

## Surviving mixed suites

- `tests/relay.test.ts`: retains installed-copy delivery/MCP, repeatable install, state-preserving uninstall and foreign target refusal; replaces auto-ack/policy semantics with non-destructive read and explicit ack. Retires held-message/operator release, LAB role aliases, vendor launch/setup and Git-status cases.
- `tests/runtime-safety.test.ts`: retains real Bun controls, package bin, install.sh and installed-launcher isolation against local/global config, dotenv, preloads, tsconfig and macros; source/symlink refusal, stable Bun fallback, provenance and self-uninstall regressions remain. Retires only hook.sh/codex-wrap.sh startup cases, the setup helper subprocess and blocking policy-hook wrapper, because those entrypoints are removed.

All current message suites, surviving runtime/install suites and typecheck form the standalone gate. F's migration guide and D's CLI/MCP tests are integrated by their owners; missing neighboring modules are reported as integration failures, never silently skipped. Historical extraction/product-test exclusions in `TESTS-UITGESLOTEN.md` retain their original meaning.
