import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { messageRuntimeFiles } from "../src/install";

const root = resolve(import.meta.dir, "..");
for (const entry of ["scripts/lead", "agents", "src/launch.ts", "src/identity.ts", "src/session-child.ts", "relay.toml"]) {
  if (existsSync(resolve(root, entry))) throw new Error(`retired product scope remains: ${entry}`);
}
const files = messageRuntimeFiles(root);
console.log(`Message package boundary verified: ${files.length} runtime files; no legacy runtime imports.`);
