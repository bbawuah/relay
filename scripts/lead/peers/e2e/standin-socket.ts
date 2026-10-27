#!/usr/bin/env bun
// Stand-in voor de inbox-socket van een Claude-TUI (alleen voor de e2e-demo): luistert op een unix-socket en zet elke
// ontvangen regel in een logbestand. Gebruik: bun standin-socket.ts <socketpad> <logbestand>
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";

const [pad, log] = process.argv.slice(2);
if (!pad || !log) {
  console.error("Gebruik: standin-socket.ts <socketpad> <logbestand>");
  process.exit(2);
}
mkdirSync(dirname(pad), { recursive: true });
rmSync(pad, { force: true });
createServer((c) => {
  let buf = "";
  c.on("data", (d) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      appendFileSync(log, `${buf.slice(0, i)}\n`);
      buf = buf.slice(i + 1);
    }
  });
  c.on("error", () => {});
}).listen(pad);
