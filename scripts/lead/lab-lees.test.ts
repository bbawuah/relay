import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schoneEnv } from "../test-integriteit";

// lab-lees.sh met een nep-ssh vooraan op PATH: het lab wordt nooit aangeroepen. De nep-ssh
// schrijft zijn argv (één argument per regel) naar ssh.log en geeft uitvoer met een eag_-sleutel.

const LAB = join(import.meta.dir, "lab-lees.sh");
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lab-lees-test-"));
  mkdirSync(join(dir, "bin"));
  writeFileSync(
    join(dir, "bin", "ssh"),
    `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$NEP_DIR/ssh.log"
echo "pod-a Running eag_AbC123xyz"
echo "fout: token eag_Geheim99 verlopen" >&2
exit "\${NEP_CODE:-0}"
`,
  );
  chmodSync(join(dir, "bin", "ssh"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const draai = (args: string[], extra: Record<string, string> = {}) => {
  const env = { ...schoneEnv(), PATH: `${join(dir, "bin")}:${process.env.PATH}`, NEP_DIR: dir, ...extra };
  const p = Bun.spawnSync(["bash", LAB, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, uit: p.stdout.toString(), fout: p.stderr.toString() };
};
const argv = () => (existsSync(join(dir, "ssh.log")) ? readFileSync(join(dir, "ssh.log"), "utf8").trimEnd().split("\n") : null);

describe("lab-lees.sh", () => {
  test("geeft de argumenten als vaste argv aan ssh jump oc", () => {
    const r = draai(["get", "pods", "-n", "mod-x", "-o", "wide", "--selector=app=web,tier=be"]);
    expect(r.code).toBe(0);
    expect(argv()).toEqual(["-T", "jump", "oc", "get", "pods", "-n", "mod-x", "-o", "wide", "--selector=app=web,tier=be"]);
  });
  for (const ok of [["describe", "pod/web-1"], ["logs", "-f", "deploy/web", "--since=1h"], ["events", "-n", "x"], ["top", "pods"], ["auth", "can-i", "get", "pods", "-n", "x"]])
    test(`laat door: ${ok.join(" ")}`, () => {
      expect(draai(ok).code).toBe(0);
      expect(argv()?.slice(2)).toEqual(["oc", ...ok]);
    });
  test("maskeert eag_-sleutels in stdout en stderr", () => {
    const r = draai(["get", "pods"]);
    expect(r.uit).toBe("pod-a Running eag_<…>\n");
    expect(r.fout).toBe("fout: token eag_<…> verlopen\n");
    expect(r.uit + r.fout).not.toContain("AbC123");
  });
  test("geeft de exitcode van ssh door", () => {
    expect(draai(["get", "pods"], { NEP_CODE: "3" }).code).toBe(3);
  });
  test("--droog roept ssh niet aan", () => {
    const r = draai(["get", "pods", "--droog"]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain("ssh -T jump oc get pods");
    expect(argv()).toBeNull();
  });

  const WEIGER: [string[], RegExp][] = [
    [[], /geef een subcommando/],
    [["exec", "pod", "--", "sh"], /geen alleen-lezen/],
    [["rsh", "pod"], /geen alleen-lezen/],
    [["port-forward", "svc/x", "8080"], /geen alleen-lezen/],
    [["cp", "pod:/x", "."], /geen alleen-lezen/],
    [["debug", "pod"], /geen alleen-lezen/],
    [["edit", "deploy/x"], /geen alleen-lezen/],
    [["apply", "-f", "x.yaml"], /geen alleen-lezen/],
    [["delete", "pod", "x"], /geen alleen-lezen/],
    [["patch", "deploy/x"], /geen alleen-lezen/],
    [["scale", "deploy/x", "--replicas=0"], /geen alleen-lezen/],
    [["rollout", "restart", "deploy/x"], /geen alleen-lezen/],
    [["login"], /geen alleen-lezen/],
    [["auth", "whoami"], /alleen 'auth can-i'/],
    [["auth"], /alleen 'auth can-i'/],
    [["get", "secrets"], /secrets lezen mag niet/],
    [["get", "secret", "x", "-o", "yaml"], /secrets lezen mag niet/],
    [["get", "pods,Secrets"], /secrets lezen mag niet/],
    [["describe", "secret/x"], /secrets lezen mag niet/],
    [["get", "secrets.v1", "-o", "json"], /secrets lezen mag niet/],
    [["auth", "can-i", "get", "secrets"], /secrets lezen mag niet/],
    [["auth", "can-i", "delete", "pods"], /schrijf- of shellactie/],
    [["get", "pods", "exec"], /schrijf- of shellactie/],
    [["get", "--raw", "/api/v1/namespaces"], /--raw/],
    [["get", "pods", "--token=abc"], /identiteit of doel/],
    [["get", "pods", "--as=system:admin"], /identiteit of doel/],
    [["get", "pods", "--kubeconfig", "/x"], /identiteit of doel/],
    [["get", "-f", "x.yaml"], /leest bestanden/],
    [["get", "-k", "dir"], /leest bestanden/],
    [["get", "pods;", "rm", "-rf", "/"], /teken buiten/],
    [["get", "pods|sh"], /teken buiten/],
    [["get", "pods&&id"], /teken buiten/],
    [["get", "$(id)"], /teken buiten/],
    [["get", "`id`"], /teken buiten/],
    [["get", "'pods'"], /teken buiten/],
    [['get"'], /geen alleen-lezen/],
    [["get", 'pods"'], /teken buiten/],
    [["get", "pods x"], /teken buiten/],
    [["get", "pods\nid"], /teken buiten/],
    [["get", "po*"], /teken buiten/],
    [["get", "~/x"], /teken buiten/],
    [["get", "a\\b"], /teken buiten/],
    [["get", "{a,b}"], /teken buiten/],
    [["get", "-o", "jsonpath={.x}"], /teken buiten/],
    [["get", "--"], /geen geldige optie/],
  ];
  for (const [args, reden] of WEIGER)
    test(`weigert ${JSON.stringify(args)}`, () => {
      const r = draai(args);
      expect(r.code).toBe(1);
      expect(r.fout).toMatch(/^lab-lees: geweigerd: /);
      expect(r.fout).toMatch(reden);
      expect(argv()).toBeNull();
    });
});
