// Per-agent Relay wrapper: fixes --peer, state and namespace; allows only send|inbox|ack|list.
// Logs the raw call privately and appends a sanitised (aliases only) view to the agent's pane log.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [alias, ...argv] = process.argv.slice(2);
const D = process.env.RELAY_DEMO_DIR!;
const peers: Record<string, string> = JSON.parse(readFileSync(`${D}/proof/peers.json`, "utf8"));
const verbs = ["send", "inbox", "ack", "list"];
if (!peers[alias] || !verbs.includes(argv[0]) || argv.some((a) => /^--(state|namespace|peer)(=|$)/.test(a))) {
  console.error(`allowed: ${verbs.join(" | ")} (identity and state are fixed for ${alias})`); process.exit(2);
}
const p = Bun.spawnSync([`${D}/prefix/bin/relay`, "--state", `${D}/state`, "--namespace", "terminal-demo", "--peer", peers[alias], ...argv],
  { env: { PATH: process.env.PATH!, HOME: `${D}/home` }, cwd: `${D}/cwd` });
const out = p.stdout.toString().trim();
const err = p.stderr.toString().split("\n").filter((l) => l && !l.includes("directory mismatch")).join("\n");
appendFileSync(`${D}/proof/log.jsonl`, JSON.stringify({ ts: Date.now(), alias, argv, out, err, rc: p.exitCode }) + "\n");

// ---- sanitised display ----
const idf = `${D}/proof/ids.json`;
const ids: Record<string, string> = existsSync(idf) ? JSON.parse(readFileSync(idf, "utf8")) : {};
for (const [a, id] of Object.entries(peers)) ids[id] = a;
let mi = Object.values(ids).filter((v) => v.startsWith("msg-")).length, ci = Object.values(ids).filter((v) => v.startsWith("conv-")).length;
const learn = (o: any, key = ""): void => {
  if (Array.isArray(o)) return o.forEach((x) => learn(x));
  if (o && typeof o === "object") return Object.entries(o).forEach(([k, v]) => learn(v, k));
  if (typeof o === "string" && /^[0-9a-f-]{36}$/.test(o) && !ids[o]) {
    if (key === "conversationId") ids[o] = `conv-${++ci}`; else if (key === "id") ids[o] = `msg-${++mi}`;
  }
};
let o: any = null; try { o = JSON.parse(out); learn(o); } catch { /* not JSON */ }
writeFileSync(idf, JSON.stringify(ids));
const al = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (u) => ids[u] ?? "id").split(D).join("<demo>");
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const B = "\x1b[1m", G = "\x1b[32m", Y = "\x1b[33m", Dm = "\x1b[2m", Z = "\x1b[0m";
const flag = (k: string) => { const i = argv.indexOf(k); return i > 0 ? al(argv[i + 1]) : ""; };
const L: string[] = [];
const ev: any = { t: Date.now(), kind: "relay", alias, verb: argv[0], rc: p.exitCode };
const sf = `${D}/proof/empty-${alias}`; // collapse consecutive empty polls into one displayed line
if (p.exitCode !== 0 || o === null) { L.push(`${B}$ ${argv[0]}${Z} ${Y}failed (rc ${p.exitCode})${Z}`, `${Y}${cut(al(err || out), 78)}${Z}`); }
else if (argv[0] === "send") {
  ev.to = argv[1]; ev.full = [al(argv[2])]; ev.key = flag("--request-key"); ev.dup = o.duplicate; ev.reply = !!flag("--reply-to");
  L.push(`${B}$ send → ${argv[1]}${Z}  ${Dm}key ${ev.key}${Z}`);
  if (ev.reply) L.push(`${Dm}  reply-to ${flag("--reply-to")} in ${flag("--conversation")}${Z}`);
  L.push(`${Dm}  "${cut(al(argv[2]), 72)}"${Z}`, `${G}  ✓ stored ${al(o.id)} · duplicate ${o.duplicate}${Z}`);
} else if (argv[0] === "inbox") {
  ev.n = o.length; ev.from = o.map((m: any) => al(m.from)); ev.full = o.map((m: any) => `${al(m.id)} from ${al(m.from)}: ${al(m.body)}`);
  if (!o.length) { if (!existsSync(sf)) { writeFileSync(sf, "1"); L.push(`${B}$ inbox${Z}`, `${Dm}  (empty, polling again later)${Z}`); } }
  else { if (existsSync(sf)) Bun.spawnSync(["rm", sf]); L.push(`${B}$ inbox${Z}`); }
  for (const m of o) L.push(`${G}  ${al(m.id)} from ${al(m.from)}${Z}`, `${Dm}  "${cut(al(m.body), 72)}"${Z}`);
} else if (argv[0] === "ack") {
  ev.acked = o.acknowledged;
  L.push(`${B}$ ack ${al(argv[1] ?? "")}${Z}`, `${o.acknowledged ? G : Y}  acknowledged: ${o.acknowledged}${Z}`);
} else L.push(`${B}$ list${Z}`);
if (L.length) appendFileSync(`${D}/proof/pane-${alias}.log`, L.join("\n") + "\n");
ev.lines = L.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
appendFileSync(`${D}/proof/events.jsonl`, JSON.stringify(ev) + "\n");
process.stdout.write(out + "\n"); if (err) process.stderr.write(err + "\n"); process.exit(p.exitCode ?? 1);
