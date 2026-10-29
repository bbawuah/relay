"""Runs ONE native CLI in its own session/process group with a hard deadline and exact-group cleanup.
Usage: python3 -I supervise.py OUTFILE PIDFILE TIMEOUT_S CWD -- CMD [ARGS...]
- stdout+stderr of the CLI go to OUTFILE; the supervisor's pid is written to PIDFILE and removed on exit.
- On deadline, INT, TERM or HUP: TERM the CLI's own process group, wait a grace period, then KILL that group, then wait.
- Only the process group created here is ever signalled. Exit code: CLI code, 124 on deadline, 128+signal if the CLI was signalled
  or the supervisor was asked to stop.
"""
import os, signal, subprocess, sys, time

out, pidfile, timeout, cwd = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
cmd = sys.argv[sys.argv.index("--") + 1:]
GRACE = 5.0
stop = {"sig": None}

def on_signal(signum, _frame):
    stop["sig"] = signum
for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
    signal.signal(s, on_signal)

with open(out, "ab") as fh:
    p = subprocess.Popen(cmd, cwd=cwd, stdout=fh, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
    with open(pidfile, "w") as f:
        f.write(str(os.getpid()))
    pgid = p.pid  # start_new_session: the CLI is its own session and group leader
    deadline = time.monotonic() + timeout
    why = None
    while p.poll() is None:
        if stop["sig"] is not None:
            why = 128 + stop["sig"]; break
        if time.monotonic() >= deadline:
            why = 124; fh.write(f"\n[deadline {int(timeout)} s reached, stopping the process group]\n".encode()); fh.flush(); break
        time.sleep(0.1)
    if why is not None or True:
        # the leader may be gone while group members survive: always clean the exact own group
        def group_alive():
            try:
                os.killpg(pgid, 0); return True
            except ProcessLookupError:
                return False
            except PermissionError:
                return True
        if group_alive():
            try: os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError: pass
            end = time.monotonic() + GRACE
            while group_alive() and time.monotonic() < end:
                p.poll(); time.sleep(0.1)
            if group_alive():
                try: os.killpg(pgid, signal.SIGKILL)
                except ProcessLookupError: pass
        p.wait()
    rc = p.returncode
    code = why if why is not None else (rc if rc >= 0 else 128 - rc)
try: os.remove(pidfile)
except OSError: pass
sys.exit(code)
