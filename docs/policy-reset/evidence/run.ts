// Reproduce terminal evidence from an exact source commit in a disposable archive.
// No installed hooks, provider sessions, sockets or live queues are used.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gitArgs } from "../../../scripts/lead/git-hard";
import { schoneEnv } from "../../../scripts/test-integriteit";

const sha = process.argv[2];
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error("usage: bun docs/policy-reset/evidence/run.ts <full-source-sha>");
const repo = resolve(import.meta.dir, "../../..");
const dir = mkdtempSync(join(tmpdir(), "relay-policy-evidence-"));
const source = join(dir, "source");
const staat = join(dir, "state");
const nu = 1_700_000_000_000;
function run(argv: string[], extra: Record<string, unknown> = {}) {
  const p = Bun.spawnSync(argv, { cwd: repo, env: schoneEnv(), stdout: "pipe", stderr: "pipe", ...extra });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
}
try {
  mkdirSync(source);
  const archive = join(dir, "source.tar");
  run(["git", ...gitArgs(["archive", "--format=tar", "-o", archive, sha, "scripts/lead"])]);
  run(["tar", "-xf", archive, "-C", source]);
  const { nieuwRecord, schrijfRecord } = await import(join(source, "scripts/lead/hooks/register.ts"));
  const { maakBus } = await import(join(source, "scripts/lead/peers/bus.ts"));
  const { draai } = await import(join(source, "scripts/lead/peers/cli.ts"));
  const b = maakBus({ staat, nu: () => nu }); // no wake provider: no-op Wekker
  for (const naam of ["alice", "bob", "recovery-target"]) {
    schrijfRecord(staat, { ...nieuwRecord(`fixture-${naam}`, { LAB_AGENT_NAAM: naam, LAB_AGENT_ROL: "agent", LAB_LEAD_NAAM: `unrelated-${naam}` }, join(dir, naam), nu), host: "geen" });
  }
  console.log(`source SHA: ${sha}`);
  console.log("capture: actual stdout from disposable fixture; synthetic names/text only");
  console.log("routing: alice and bob have different leads; role=agent; no inbound override");
  const sent = await b.send("alice", "bob", "fixture question");
  console.log(`send alice -> bob: ${JSON.stringify(sent)}`);
  const inbox = b.inbox("bob");
  console.log(`read bob: unread=${inbox.length}, held=${b.vastgehouden("bob").length}`);
  b.ack("bob", inbox.map((e: { id: string }) => e.id));
  console.log(`ack bob: unread=${b.inbox("bob").length}`);
  if (inbox[0]) {
    const reply = await b.send("bob", "alice", "fixture reply", { antwoord_op: inbox[0].id });
    console.log(`reply bob -> alice: ${JSON.stringify(reply)}`);
    const replies = b.inbox("alice");
    console.log(`read alice: unread=${replies.length}, hop=${replies[0]?.hop}`);
    b.ack("alice", replies.map((e: { id: string }) => e.id));
    console.log(`ack alice: unread=${b.inbox("alice").length}`);
  } else console.log("reply: no delivered question; nothing to acknowledge or answer");

  const heldId = "018bcfe5-6800-7000-8000-000000000001";
  const held = { id: heldId, van: "alice", naar: "recovery-target", draad: heldId, ts: new Date(nu).toISOString(), hop: 1, herkomst: "schoon", soort: "bericht", tekst: "synthetic historical fixture" };
  mkdirSync(join(staat, "peers/vastgehouden"), { recursive: true });
  writeFileSync(join(staat, "peers/vastgehouden/recovery-target.jsonl"), `${JSON.stringify(held)}\n`);
  const env = { LAB_LEAD_STAAT: staat, LAB_AGENT_NAAM: "recovery-target", LAB_AGENT_ROL: "agent" };
  console.log("recovery: one historical fixture; caller owns mailbox; LAB_AGENT_ROL=agent");
  for (let i = 1; i <= 2; i++) {
    const r = await draai(["vrijgeven", "recovery-target", heldId], env, b);
    console.log(`$ cli.ts vrijgeven recovery-target ${heldId} [attempt ${i}]`);
    console.log(`exit=${r.code}: ${(r.uit || r.fout).trim()}`);
  }
  console.log(`recovery counts: held=${b.vastgehouden("recovery-target").length}, unread=${b.inbox("recovery-target").length}`);

  const hook = Bun.spawnSync(["/bin/bash", join(source, "scripts/lead/hooks/grenzen.sh")], {
    env: { PATH: "/usr/bin:/bin", HOME: dir, LAB_AGENT_ROL: "lead-proef", TMUX_PANE: "%own" },
    stdin: new TextEncoder().encode(JSON.stringify({ cwd: source, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "tmux send-keys -t %other -l synthetic-fixture" } })),
    stdout: "pipe", stderr: "pipe",
  });
  console.log("hook probe: evaluate synthetic JSON only; the tmux command is never executed");
  console.log(`retired hook exit=${hook.exitCode}, stdout bytes=${hook.stdout.length}, stderr=${hook.stderr.toString().trim() || "(empty)"}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
