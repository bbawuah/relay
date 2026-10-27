import { afterEach, describe, expect, test } from "bun:test";
import { SPAWN_STUB, STAPPEN, codexConfig } from "./codex-demo";
import { type Nep, antwoord, startNep } from "./nep-responses";

// De echte Codex-run (codex-demo.ts) eist codex en tmux en duurt ~30 s: die draait handmatig (README, F-echte-demo.md), niet in
// de poort. Hier de onderdelen die geen codex nodig hebben: de nep-Responses-server, de config en de stappen.

let nep: Nep | undefined;
afterEach(() => {
  nep?.stop();
  nep = undefined;
});

const events = (sse: string) => sse.split("\n\n").filter(Boolean).map((b) => ({ event: /^event: (.*)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? "{}") }));

describe("nep-responses", () => {
  test("een toolaanroep: created, item added/done met namespace en arguments, completed", () => {
    const e = events(antwoord({ call: { namespace: "mcp__peers", name: "send", args: { naar: "x" } } }, 2));
    expect(e.map((x) => x.event)).toEqual(["response.created", "response.output_item.added", "response.output_item.done", "response.completed"]);
    expect(e[2]?.data.item).toMatchObject({ type: "function_call", call_id: "call_2", name: "send", namespace: "mcp__peers", arguments: '{"naar":"x"}' });
  });

  test("een eindbericht: message met output_text, zonder namespace", () => {
    const e = events(antwoord({ tekst: "klaar\n\nvrij" }, 3));
    expect(e[2]?.data.item).toMatchObject({ type: "message", role: "assistant", content: [{ type: "output_text", text: "klaar\n\nvrij" }] });
    expect(e[3]?.data.response.status).toBe("completed");
  });

  test("de server loopt de stappen af, herhaalt de laatste, legt verzoeken vast en kent /models", async () => {
    nep = startNep([{ call: { name: "exec_command", args: { cmd: "ls" } } }, { tekst: "klaar" }]);
    expect(nep.poort).toBeGreaterThan(0);
    const post = async () => (await fetch(`${nep!.url}/responses`, { method: "POST", body: '{"input":"hoi"}' })).text();
    const [a, b, c] = [await post(), await post(), await post()];
    expect(a).toContain("function_call");
    expect(b).toContain('"text":"klaar"');
    expect(c).toContain('"text":"klaar"');
    expect(await (await fetch(`${nep.url}/models`)).json()).toEqual({ models: [] });
    expect((await fetch(`${nep.url}/onzin`)).status).toBe(404);
    expect(nep.verzoeken.filter((v) => v.pad.endsWith("/responses")).map((v) => v.body)).toEqual(['{"input":"hoi"}', '{"input":"hoi"}', '{"input":"hoi"}']);
  });
});

describe("codex-demo onderdelen", () => {
  test("de stappen: Bash, dan peers.send aan de lead, dan een eindbericht met de slotregel vrij", () => {
    expect(STAPPEN).toHaveLength(3);
    expect(STAPPEN[0]).toMatchObject({ call: { name: "exec_command" } });
    expect(STAPPEN[1]).toMatchObject({ call: { namespace: "mcp__peers", name: "send", args: { naar: "lead-e2e" } } });
    expect((STAPPEN[2] as { tekst: string }).tekst.trimEnd().endsWith("vrij")).toBe(true);
  });

  test("de CODEX_HOME-config wijst naar de nep-server, vraagt geen inlog en vertrouwt alleen de worktree", () => {
    const c = codexConfig("http://127.0.0.1:1234/v1", "/tmp/wd");
    expect(c).toContain('base_url = "http://127.0.0.1:1234/v1"');
    expect(c).toContain("requires_openai_auth = false");
    expect(c).toContain('[projects."/tmp/wd"]\ntrust_level = "trusted"');
    expect(c.match(/\[projects\./g)).toHaveLength(1);
  });

  test("het spawn-script van de demo opent een venster in de tmux van de demo en niets anders", () => {
    expect(SPAWN_STUB).toContain("tmux new-window -P -F '#{pane_id}' -c \"$2\" \"$3\"");
    expect(SPAWN_STUB).not.toContain(".claude");
    expect(SPAWN_STUB).toContain('[ "$1" = window ] || exit 1');
  });
});
