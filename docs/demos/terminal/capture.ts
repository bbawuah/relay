// Captures the four tmux panes of the owned socket (capture-pane -p -e) and appends a frame when anything changed.
// Usage: bun capture.ts SOCKET PANEIDS(TL,TR,BL,BR comma separated) OUT.jsonl STOPFILE
import { appendFileSync, existsSync } from "node:fs";
const [sock, idList, out, stop] = process.argv.slice(2);
const tm = (...a: string[]) => Bun.spawnSync(["env", "-u", "TMUX", "-u", "TMUX_PANE", "tmux", "-f", "/dev/null", "-S", sock, ...a]).stdout.toString();
const ids = idList.split(",");
let prev = "";
while (!existsSync(stop)) {
  const panes = ids.map((i) => tm("capture-pane", "-p", "-e", "-t", i).replace(/\s+$/g, ""));
  const key = panes.join("\u0000");
  if (key !== prev) { prev = key; appendFileSync(out, JSON.stringify({ t: Date.now(), panes }) + "\n"); }
  await Bun.sleep(250);
}
