import { claimSession, type LaunchLease } from "./identity";

// Only trusted Relay code runs before ownership is committed. stdin remains
// inherited and execve preserves the process whose birth time owns the lease.
if (import.meta.main) {
  try {
    const { state, lease, argv } = JSON.parse(process.argv[2]!) as { state: string; lease: LaunchLease; argv: string[] };
    if (!Array.isArray(argv) || !argv.length || typeof process.execve !== "function") throw new Error("Relay needs Bun >= 1.4.2 with process.execve");
    claimSession(state, lease);
    process.execve(argv[0]!, argv, process.env);
    throw new Error("Relay vendor execve returned unexpectedly");
  } catch (error) {
    console.error(`relay: ${(error as Error).message}`);
    process.exit(1);
  }
}
