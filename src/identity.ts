import type { Database } from "bun:sqlite";
import { claimLauncherIdentiteit, isLauncherOwner, launcherOwner, withLaunchLock, type LauncherOwner } from "../scripts/lead/hooks/register";
export { launcherOwner, ownerStatus, withLaunchLock } from "../scripts/lead/hooks/register";

export type LaunchLease = { spawn: string; name: string; cwd: string; vendor: "claude" | "codex"; owner: LauncherOwner };

export function launchLeases(db: Database): LaunchLease[] {
  return (db.query("SELECT payload FROM leases").all() as { payload: string }[]).map(({ payload }) => {
    const lease = JSON.parse(payload) as LaunchLease;
    if (!lease || !isLauncherOwner(lease.owner) || typeof lease.spawn !== "string" || !lease.spawn || typeof lease.name !== "string" || !lease.name || typeof lease.cwd !== "string" || !lease.cwd.startsWith("/") || !["claude", "codex"].includes(lease.vendor)) throw new Error("unrecognized Relay launcher reservation; preserving state");
    return lease;
  });
}

export function saveLaunchLease(db: Database, lease: LaunchLease): void {
  db.query("INSERT INTO leases (spawn, payload) VALUES (?, ?)").run(lease.spawn, JSON.stringify(lease));
}

export function deleteLaunchLease(db: Database, spawn: string): void {
  db.query("DELETE FROM leases WHERE spawn = ?").run(spawn);
}

/** The bootstrap claims itself before exec; a reclaimed/missing reservation
 * can never authorize a vendor. Both sides of the handoff use the same lock. */
export function claimSession(state: string, expected: LaunchLease): void {
  const owner = launcherOwner();
  withLaunchLock(state, (db) => {
    const lease = launchLeases(db).find((item) => item.spawn === expected.spawn);
    if (!lease || lease.name !== expected.name || lease.cwd !== expected.cwd || lease.vendor !== expected.vendor || lease.owner.pid !== expected.owner.pid || lease.owner.start !== expected.owner.start) throw new Error("Relay session reservation changed or disappeared before bootstrap");
    if (lease.vendor === "codex") claimLauncherIdentiteit(state, lease.cwd, lease.spawn, lease.owner, owner);
    db.query("UPDATE leases SET payload = ? WHERE spawn = ?").run(JSON.stringify({ ...lease, owner }), lease.spawn);
  });
}
