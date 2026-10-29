// Records a REAL run of the installed relay CLI against disposable state and
// writes a sanitised JSONL cast. Roles in this script are scripted: no model
// is involved. Usage: bun docs/demos/capture.ts handoff|subagents
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Step =
  | { host: string }
  | { note: string }
  | { as?: string; argv: (c: Ctx) => string[]; label?: string };
type Ctx = { peer: (n: string) => string; msg: (n: number) => string; conv: (n: number) => string };

const root = join(import.meta.dir, "..", "..");
const scenario = process.argv[2];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

const peersFor: Record<string, [string, string?, string?][]> = {
  handoff: [["claude-lead", "claude", "demo-claude-1"], ["codex-reviewer", "codex", "demo-codex-1"], ["observer"]],
  subagents: [
    ["claude-parent", "claude", "demo-claude-parent"], ["claude-sub", "claude", "demo-claude-sub"],
    ["codex-parent", "codex", "demo-codex-parent"], ["codex-sub", "codex", "demo-codex-sub"],
  ],
};

const send = (as: string, to: string, text: string, key: string, extra: (c: Ctx) => string[] = () => []): Step => ({
  as, argv: (c) => ["send", to, text, "--request-key", key, ...extra(c)],
});
const inbox = (as: string): Step => ({ as, argv: () => ["inbox"] });
const ack = (as: string, n: number): Step => ({ as, argv: (c) => ["ack", c.msg(n)] });
const reply = (n: number, cv: number) => (c: Ctx) => ["--conversation", c.conv(cv), "--reply-to", c.msg(n)];

const steps: Record<string, Step[]> = {
  handoff: [
    send("claude-lead", "codex-reviewer", "Review parse.ts for edge cases", "handoff-1"),
    send("claude-lead", "codex-reviewer", "Review parse.ts for edge cases", "handoff-1"),
    inbox("codex-reviewer"), inbox("codex-reviewer"),
    inbox("observer"), ack("observer", 1),
    ack("codex-reviewer", 1),
    send("codex-reviewer", "claude-lead", "Found 2 edge cases", "handoff-2", reply(1, 1)),
    inbox("claude-lead"), ack("claude-lead", 2), inbox("claude-lead"),
  ],
  subagents: [
    send("claude-parent", "codex-parent", "Plan the cache fix", "plan-1"),
    { host: "Codex runtime starts its own subagent codex-sub" },
    inbox("codex-parent"), ack("codex-parent", 1),
    send("codex-parent", "codex-sub", "Check cache invalidation", "sub-1"),
    inbox("codex-sub"), ack("codex-sub", 2),
    send("codex-sub", "codex-parent", "Bug in invalidate()", "sub-2", reply(2, 2)),
    inbox("codex-parent"), ack("codex-parent", 3),
    send("codex-parent", "claude-parent", "Plan ready: fix invalidate()", "plan-2", reply(1, 1)),
    { host: "Claude runtime starts its own subagent claude-sub" },
    inbox("claude-parent"), ack("claude-parent", 4),
    send("claude-parent", "claude-sub", "Apply the plan", "apply-1"),
    inbox("claude-sub"), ack("claude-sub", 5),
    ack("claude-sub", 4),
  ],
};
if (!steps[scenario]) { console.error("usage: capture.ts handoff|subagents"); process.exit(2); }

const tmp = mkdtempSync("/private/tmp/relay-h-demo.");
const home = join(tmp, "home"), cwd = join(tmp, "cwd"), prefix = join(tmp, "prefix"), state = join(tmp, "state");
mkdirSync(home); mkdirSync(cwd);
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home };

try {
  const inst = Bun.spawnSync([join(root, "install.sh"), "--prefix", prefix], { env, cwd: root });
  if (inst.exitCode !== 0) throw new Error("install failed");
  const relay = join(prefix, "bin", "relay");
  const run = (argv: string[]) => {
    const t0 = performance.now();
    const p = Bun.spawnSync([relay, "--state", state, "--namespace", "showcase", ...argv], { env, cwd });
    return { out: p.stdout.toString().trim(), rc: p.exitCode, ms: Math.round(performance.now() - t0) };
  };
  const version = run(["--version"]).out;
  const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: root }).stdout.toString().trim();

  const ids = new Map<string, string>(); // real uuid -> alias
  const msgs: string[] = [], convs: string[] = [];
  const peerId: Record<string, string> = {};
  const alias = (s: string) => s.replace(UUID, (u) => ids.get(u) ?? u);
  const ctx: Ctx = { peer: (n) => peerId[n], msg: (n) => msgs[n - 1], conv: (n) => convs[n - 1] };
  const learn = (o: unknown) => {
    if (Array.isArray(o)) return o.forEach(learn);
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string" && UUID.test(v)) {
        UUID.lastIndex = 0;
        if (!ids.has(v)) {
          if (k === "conversationId") { convs.push(v); ids.set(v, `conv-${convs.length}`); }
          else if (k === "id") { msgs.push(v); ids.set(v, `msg-${msgs.length}`); }
        }
      } else learn(v);
    }
    UUID.lastIndex = 0;
  };
  const clean = (text: string) => {
    let o: unknown;
    try { o = JSON.parse(text); } catch { return alias(text); }
    const strip = (v: unknown): unknown => Array.isArray(v) ? v.map(strip)
      : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) =>
          !["createdAt", "expiresAt", "version", "namespace"].includes(k)).map(([k, x]) => [k, strip(x)])) : v;
    return alias(JSON.stringify(strip(o)));
  };
  const quote = (a: string) => (/^[\w.:=@%+\/-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

  const events: object[] = [{
    kind: "meta", scenario, relay: version, source: head, label: "replay-real-cli",
    note: "Real relay CLI run, disposable state, roles scripted, no model involved",
  }];
  for (const [name, host, session] of peersFor[scenario]) {
    const argv = ["register", "--name", name, ...(host ? ["--host", host, "--session-id", session!] : [])];
    const r = run(argv);
    peerId[name] = r.out; ids.set(r.out, name);
    events.push({ kind: "cmd", text: `relay ${argv.map(quote).join(" ")}`, out: name, rc: r.rc, ms: r.ms });
  }
  for (const s of steps[scenario]) {
    if ("host" in s) { events.push({ kind: "host", text: s.host }); continue; }
    if ("note" in s) { events.push({ kind: "note", text: s.note }); continue; }
    const argv = s.argv(ctx);
    const full = s.as ? ["--peer", peerId[s.as], ...argv] : argv;
    const r = run(full);
    try { learn(JSON.parse(r.out)); } catch { /* not JSON */ }
    const shown = ["relay", ...(s.as ? ["--peer", s.as] : []), ...argv].map((a) => quote(alias(a)));
    events.push({ kind: "cmd", text: shown.join(" "), out: clean(r.out), rc: r.rc, ms: r.ms });
  }
  mkdirSync(join(import.meta.dir, "casts"), { recursive: true });
  const outFile = join(import.meta.dir, "casts", `${scenario}.jsonl`);
  writeFileSync(outFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  console.log(`wrote ${outFile} (${events.length} events)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
