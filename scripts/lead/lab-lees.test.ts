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
  const p = Bun.spawnSync(["/bin/bash", "-p", LAB, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, uit: p.stdout.toString(), fout: p.stderr.toString() };
};
const argv = () => (existsSync(join(dir, "ssh.log")) ? readFileSync(join(dir, "ssh.log"), "utf8").trimEnd().split("\n") : null);

describe("lab-lees.sh", () => {
  test("geeft de argumenten als vaste argv aan ssh jump oc", () => {
    const r = draai(["get", "pods", "-n", "mod-x", "-o", "wide", "--selector=app=web,tier=be"]);
    expect(r.code).toBe(0);
    expect(argv()).toEqual(["-T", "jump", "oc", "get", "pods", "-n", "mod-x", "-o", "wide", "--selector=app=web,tier=be"]);
  });
  for (const ok of [
    ["get", "pods", "-o", "yaml"],
    ["get", "pods", "web-1", "-n", "x", "-o", "yaml"],
    ["get", "deploy/web", "-o=json"],
    ["get", "svc,ep", "-ojson"],
    ["get", "deployments.apps", "--output=yaml", "--ignore-not-found"],
    ["get", "all", "-o", "wide"],
    ["get", "pods", "-o", "name", "-A"],
    ["describe", "pod/web-1"], ["logs", "-f", "deploy/web", "--since=1h"], ["events", "-n", "x"], ["top", "pods"], ["auth", "can-i", "get", "pods", "-n", "x"]])
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
    // -o alleen wide|name|yaml|json
    [["get", "pods", "-o", "jsonpath=.items"], /alleen wide, name, yaml of json/],
    [["get", "cm", "-o", "custom-columns=X:.data"], /alleen wide, name, yaml of json/],
    [["get", "pods", "--output=custom-columns=X:.spec"], /alleen wide, name, yaml of json/],
    [["get", "pods", "-ocustom-columns=X:.spec"], /alleen wide, name, yaml of json/],
    [["get", "pods", "-o=go-template=x"], /alleen wide, name, yaml of json/],
    [["get", "pods", "-o"], /alleen wide, name, yaml of json/],
    [["get", "pods", "--template=x"], /templates/],
    [["get", "pods", "--templates", "x"], /templates/],
    [["get", "pods", "--cache-dir=/tmp/x"], /logs of cache/],
    [["get", "pods", "--log-dir=/tmp"], /logs of cache/],
    [["get", "pods", "--log-file", "/tmp/x"], /logs of cache/],
    [["get", "pods", "--logtostderr"], /logs of cache/],
    [["get", "pods", "--loglevel=9"], /logs of cache/],
    [["get", "pods", "-v"], /logs of cache/],
    [["get", "pods", "--v=9"], /logs of cache/],
    [["get", "pods", "--v"], /logs of cache/],
    [["get", "pods", "--password-file=x"], /-file/],
    [["get", "pods", "-n", "x-file"], /-file/],
    // samengestelde korte opties
    [["get", "pods", "-Ao", "yaml"], /korte optie/],
    [["get", "pods", "-lapp=web"], /korte optie/],
    [["get", "pods", "-vv"], /korte optie/],
    // -o yaml|json alleen op een allowlist van resources
    [["get", "configmaps", "-o", "yaml"], /mag niet; alleen pods/],
    [["get", "cm", "x", "-o", "json"], /'cm' mag niet/],
    [["get", "configmap/x", "-o", "yaml"], /mag niet; alleen pods/],
    [["get", "pods,cm", "-o", "yaml"], /'cm' mag niet/],
    [["get", "pods/x", "cm/y", "-o", "yaml"], /'cm' mag niet/],
    [["get", "route", "-o", "yaml"], /'route' mag niet/],
    [["get", "routes.route.openshift.io", "-o", "yaml"], /mag niet/],
    [["get", "oauthclient", "-o", "json"], /mag niet/],
    [["get", "bc", "-o", "yaml"], /'bc' mag niet/],
    [["get", "dc", "-o", "yaml"], /'dc' mag niet/],
    [["get", "all", "-o", "yaml"], /'all' mag niet/],
    [["get", "--ignore-not-found", "configmaps", "pods", "-o", "yaml"], /'configmaps' mag niet/],
    [["get", "--onbekend", "configmaps", "pods", "-o", "yaml"], /--optie=waarde/],
    [["get", "-o", "yaml"], /zonder resource/],
    [["events", "-o", "yaml"], /alleen bij get/],
    [["top", "pods", "-o", "json"], /alleen bij get/],
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
