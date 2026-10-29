// Turns a recorded run (proof/frames.jsonl + proof/events.jsonl) into the sanitised 4-pane cast, transcript and captions.
// Usage: bun to-cast.ts PROOFDIR OUT.jsonl TRANSCRIPT.md [--preview]
// Transformations (all documented in README.md): waits are shortened (per-frame cap, total <= ~65 s), pane text is
// captured verbatim (aliases only; paths of the private demo dir are replaced by <demo>), and the output is refused
// if it still contains a home/private path, a UUID, a vendor session marker or a T3 name.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const [proof, outCast, outMd, flag] = process.argv.slice(2);
const rd = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const frames: { t: number; panes: string[] }[] = rd(`${proof}/frames.jsonl`);
const events: any[] = rd(`${proof}/events.jsonl`);
const dir = proof.replace(/\/proof\/?$/, "");
const scrub = (s: string) => s.split(dir).join("<demo>");
const titles = ["Claude parent · claude-parent", "Codex parent · codex-parent", "Claude subagent · claude-sub", "Codex subagent · codex-sub"];
const preview = flag === "--preview";
const banner = preview
  ? "PREVIEW · captured tmux panes · no model run yet · four panes, one tmux window"
  : "REPLAY of captured terminal panes · real native CLIs, one tmux window · waits shortened";
const pretty = (e: any) => {
  if (e.kind === "process" && e.what === "start") return `SHELL · process creation: ${e.role} started by ${e.by} (not Relay)`;
  if (e.kind === "process" && e.what === "child-request") return `SHELL · ${e.by} asked the shell to start its own helper process in its pane (not Relay)`;
  if (e.kind === "process" && e.what === "exit") return `SHELL · ${e.role} process exited, rc ${e.rc}`;
  if (e.kind === "relay") {
    if (e.verb === "send") return e.dup ? `RELAY · ${e.alias} retried the same key: same receipt, duplicate true` : `RELAY · ${e.alias} sends to ${e.to} (key ${e.key})`;
    if (e.verb === "inbox") return e.n ? `RELAY · ${e.alias} reads its inbox (reading does not remove)` : `RELAY · ${e.alias} polls its inbox: empty`;
    if (e.verb === "ack") return `RELAY · ${e.alias} acknowledges receipt (ack = received, not done)`;
  }
  return "";
};
const marks = events.map((e) => ({ t: e.t, text: pretty(e) })).filter((m) => m.text);
const caption = (t: number) => { let c = preview ? "Four terminal panes in one window. Messages travel through Relay mailboxes; the shell only starts processes." : ""; for (const m of marks) if (m.t <= t) c = m.text; return c; };
// shorten waits
let cap = 1.4; const gaps = (c: number) => frames.map((f, i) => Math.max(0.25, Math.min(c, ((frames[i + 1]?.t ?? f.t + 4000) - f.t) / 1000)));
let d = gaps(cap); while (d.reduce((a, b) => a + b, 0) > 65 && cap > 0.3) { cap *= 0.85; d = gaps(cap); }
if (frames.length) d[d.length - 1] = 5;
const cast = frames.map((f, i) => JSON.stringify({ dur: +d[i].toFixed(2), banner, caption: caption(f.t), panes: f.panes.map((a, k) => ({ title: titles[k], ansi: scrub(a) })) }));
const bad = /\/Users\/|\/private\/|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|T3|delegate_task|session_id|CLAUDECODE/;
const hit = cast.find((l) => bad.test(l.replace(/\\u001b\[[0-9;]*m/g, ""))); // scan the text; SGR escapes are inert
if (hit) { console.error("refusing to publish: leak pattern in cast:", bad.exec(hit)?.[0]); process.exit(1); }
writeFileSync(outCast, cast.join("\n") + "\n");
// transcript (sanitised: aliases and bodies as written by the agents)
const t0 = events[0]?.t ?? 0; const md: string[] = ["# Four-pane terminal demo: transcript", "", "Process creation (SHELL) and Relay messaging (RELAY) are separate kinds of event. Times are relative to the start of the run; waits in the GIF are shortened.", "", "```text"];
for (const e of events) {
  const ts = `+${String(Math.round((e.t - t0) / 1000)).padStart(3)}s`;
  if (e.kind === "relay") { md.push(`${ts} RELAY ${e.alias}: ${e.lines?.[0] ?? e.verb}`); for (const l of (e.lines ?? []).slice(1)) md.push(`       ${l}`); for (const f of e.full ?? []) md.push(`       body: ${scrub(f)}`); }
  else if (e.kind === "process") md.push(`${ts} SHELL ${pretty(e).replace(/^SHELL · /, "")}${e.model ? ` · model (CLI metadata): ${e.model}` : ""}`);
}
md.push("```", "");
const text = md.join("\n"); if (bad.test(text)) { console.error("refusing: leak pattern in transcript:", bad.exec(text)?.[0]); process.exit(1); }
writeFileSync(outMd, text);
console.log(`${frames.length} frames, ${d.reduce((a, b) => a + b, 0).toFixed(1)} s, ${events.length} events`);
