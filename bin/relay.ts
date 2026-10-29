#!/usr/bin/env bun
import { main } from "../src/cli";

try {
  // Bus.klaar() drains wake-ups; its safety timers must not keep a CLI alive.
  process.exit(await main(process.argv.slice(2)));
} catch (error) {
  console.error(`relay: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
