#!/usr/bin/env python3
"""Samenvatting van sessielogs voor /retro. Alleen lezen. Python 3 stdlib.

  sessie-samenvatting.py zoek [--project DEEL] [--slug DEEL] [--dagen N] [--max N]
  sessie-samenvatting.py samenvat <sessie-id | pad.jsonl> [--geen-subagents] [--json]

Uitvoer bevat alleen aantallen, tijden, toolnamen, basenames en korte foutregels
(afgekapt, geheimen weggestreept). Nooit berichttekst, denkwerk of toolinvoer.
"""
import sys, os, re, json, glob, hashlib, collections, datetime, argparse

ROOT = os.path.expanduser("~/.claude/projects")
GEHEIM = re.compile(r"(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|eyJ[A-Za-z0-9_-]{10,}|[A-Za-z0-9+/_-]{32,}|(?i:key|token|secret|password|wachtwoord)\s*[=:]\s*\S+)")
WEIGER = re.compile(r"(permission|denied|not allowed|blocked|geweigerd|classifier|auto mode|hook|rejected|doesn't want|user declined)", re.I)

def schoon(s, n=110):
    s = (s or "").strip().splitlines()[0] if (s or "").strip() else ""
    s = GEHEIM.sub("[weg]", s.replace(os.path.expanduser("~"), "~"))
    return s[:n]

def tijd(ts):
    try:
        return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
    except Exception:
        return None

def regels(pad):
    with open(pad, errors="replace") as f:
        for l in f:
            try:
                yield json.loads(l)
            except Exception:
                continue

def titel(pad):
    t = None
    for d in regels(pad):
        if d.get("type") == "custom-title" and d.get("customTitle"): t = d["customTitle"]
        elif d.get("type") == "agent-name" and d.get("agentName") and not t: t = d["agentName"]
        elif d.get("slug") and not t: t = d["slug"]
    return schoon(t, 40) if t else t

def zoek(a):
    nu = datetime.datetime.now().timestamp()
    rijen = []
    for p in glob.glob(f"{ROOT}/*/*.jsonl"):
        proj = os.path.basename(os.path.dirname(p))
        if a.project and a.project not in proj: continue
        st = os.stat(p)
        if a.dagen and nu - st.st_mtime > a.dagen * 86400: continue
        t = titel(p) or ""
        if a.slug and a.slug.lower() not in t.lower() and a.slug not in os.path.basename(p): continue
        sid = os.path.basename(p)[:-6]
        sub = len(glob.glob(f"{os.path.dirname(p)}/{sid}/subagents/*.jsonl"))
        rijen.append((st.st_mtime, sid, t, st.st_size, sub, proj))
    rijen.sort(reverse=True)
    print("laatst gewijzigd     | sessie-id                            | naam                 | KB    | sub | project")
    for m, sid, t, sz, sub, proj in rijen[: a.max]:
        print(f"{datetime.datetime.fromtimestamp(m):%Y-%m-%d %H:%M} | {sid} | {t[:20]:20} | {sz//1024:5} | {sub:3} | ...{proj[-30:]}")

def vind(ref):
    if os.path.isfile(ref): return ref
    r = glob.glob(f"{ROOT}/*/{ref}*.jsonl")
    if len(r) != 1: sys.exit(f"{len(r)} logs voor '{ref}'; gebruik 'zoek'")
    return r[0]

def samenvat_een(pad):
    S = dict(bron=os.path.basename(pad), beurten=0, tools=collections.Counter(), fouten=[], weigeringen=[],
             hooks=[], herhaald=collections.Counter(), grote=[], compact=0, usage=collections.Counter(),
             modellen=collections.Counter(), begin=None, eind=None, gaten=[], leeslijst=collections.Counter(),
             invoerlijst=collections.Counter(), stops=0)
    open_ = {}
    seen_msg = set(); vorig = None
    for d in regels(pad):
        ts = tijd(d.get("timestamp") or "")
        if ts:
            S["begin"] = S["begin"] or ts; S["eind"] = ts
            if vorig and (ts - vorig).total_seconds() > 1200: S["gaten"].append((vorig, ts))
            vorig = ts
        ty = d.get("type"); m = d.get("message")
        if ty == "system":
            st = d.get("subtype")
            if st and "compact" in st: S["compact"] += 1
            if st == "stop_hook_summary":
                S["stops"] += 1
                if d.get("hookErrors") or d.get("preventedContinuation"):
                    S["hooks"].append((ts, schoon(json.dumps(d.get("hookErrors") or "geblokkeerd"))))
        if ty == "summary": S["compact"] += 1
        if not isinstance(m, dict): continue
        if ty == "assistant":
            mid = m.get("id") or d.get("uuid")
            u = m.get("usage") or {}
            if mid not in seen_msg:
                seen_msg.add(mid); S["beurten"] += 1
                for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
                    S["usage"][k] += u.get(k) or 0
                S["modellen"][m.get("model") or "?"] += 1
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    n = b.get("name"); inp = b.get("input") or {}
                    S["tools"][n] += 1
                    open_[b["id"]] = (n, ts)
                    h = hashlib.md5(json.dumps(inp, sort_keys=True).encode()).hexdigest()[:8]
                    S["invoerlijst"][(n, h)] += 1
                    if n == "Read" and inp.get("file_path"):
                        S["leeslijst"][os.path.basename(inp["file_path"])] += 1
        elif ty == "user" and isinstance(m.get("content"), list):
            for b in m["content"]:
                if not (isinstance(b, dict) and b.get("type") == "tool_result"): continue
                n, t0 = open_.get(b.get("tool_use_id"), ("?", None))
                c = b.get("content")
                tekst = c if isinstance(c, str) else " ".join(x.get("text", "") for x in c if isinstance(x, dict)) if isinstance(c, list) else ""
                if len(tekst) > 20000: S["grote"].append((ts, n, len(tekst)))
                if b.get("is_error"):
                    r = (ts, n, schoon(tekst))
                    (S["weigeringen"] if WEIGER.search(tekst[:400]) else S["fouten"]).append(r)
    for (n, h), k in S["invoerlijst"].items():
        if k >= 3: S["herhaald"][f"{n}#{h}"] = k
    return S

def hm(t): return t.strftime("%H:%M:%S") if t else "?"

def tel_op(lijst):
    c = collections.Counter((n, s) for _, n, s in lijst); return c.most_common(8)

def print_een(S):
    u = S["usage"]; dur = (S["eind"] - S["begin"]) if S["begin"] and S["eind"] else None
    print(f"## {S['bron']}")
    print(f"tijd {hm(S['begin'])}-{hm(S['eind'])} ({str(dur).split('.')[0] if dur else '?'}), beurten {S['beurten']}, "
          f"modellen {dict(S['modellen'])}, compactie {S['compact']}")
    print(f"usage: invoer {u['input_tokens']}, uitvoer {u['output_tokens']}, cache-lezen {u['cache_read_input_tokens']}, "
          f"cache-schrijven {u['cache_creation_input_tokens']}")
    print("tools: " + ", ".join(f"{k} {v}" for k, v in S["tools"].most_common(12)))
    if S["herhaald"]: print("identieke aanroepen >=3x: " + ", ".join(f"{k} x{v}" for k, v in S["herhaald"].most_common(6)))
    r = [f"{k} x{v}" for k, v in S["leeslijst"].most_common(5) if v >= 3]
    if r: print("vaak herlezen (basename): " + ", ".join(r))
    print(f"fouten {len(S['fouten'])}, weigeringen {len(S['weigeringen'])}, stop-hooks {S['stops']} (met fout/blokkade {len(S['hooks'])})")
    for (n, s), k in tel_op(S["fouten"]): print(f"  fout x{k} [{n}] {s}")
    for ts, n, s in S["weigeringen"][:8]: print(f"  weigering {hm(ts)} [{n}] {s}")
    for ts, s in S["hooks"][:5]: print(f"  hook {hm(ts)} {s}")
    for ts, n, ln in S["grote"][:6]: print(f"  groot resultaat {hm(ts)} [{n}] {ln//1000}k tekens")
    for a, b in S["gaten"][:5]: print(f"  stilte {hm(a)}-{hm(b)}")
    print()

def samenvat(a):
    pad = vind(a.ref); sid = os.path.basename(pad)[:-6]
    logs = [pad]
    if not a.geen_subagents:
        logs += sorted(glob.glob(f"{os.path.dirname(pad)}/{sid}/subagents/*.jsonl"))
    print(f"# sessie {sid} naam '{titel(pad) or '?'}' ({len(logs)-1} subagent-logs)\n")
    for p in logs: print_een(samenvat_een(p))
    print("Tokengewichten in dollars: bun run meting (scripts/meting/verbruik.ts), niet hier.")

def main():
    ap = argparse.ArgumentParser(); sp = ap.add_subparsers(dest="cmd", required=True)
    z = sp.add_parser("zoek"); z.add_argument("--project"); z.add_argument("--slug"); z.add_argument("--dagen", type=int, default=0); z.add_argument("--max", type=int, default=15)
    s = sp.add_parser("samenvat"); s.add_argument("ref"); s.add_argument("--geen-subagents", action="store_true")
    a = ap.parse_args()
    zoek(a) if a.cmd == "zoek" else samenvat(a)

main()
