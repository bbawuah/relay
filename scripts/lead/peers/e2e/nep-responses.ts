// Nep-Responses-API voor de Codex-demo (F2): antwoordt Codex volgens vaste stappen, zonder netwerk en zonder inlog.
// Een stap is een toolaanroep (`call`) of een eindbericht (`tekst`). Na de laatste stap blijft de server de laatste herhalen.
// Gebruikt door codex-demo.ts; draait in het proces van de demo op 127.0.0.1 met een vrije poort.

export type Stap = { call: { name: string; namespace?: string; args: Record<string, unknown> } } | { tekst: string };
export type Nep = { poort: number; url: string; verzoeken: { pad: string; body: string }[]; stop: () => void };

const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

/** De SSE-body van één antwoord op /v1/responses voor `stap` (n = volgnummer, begint bij 1). */
export function antwoord(stap: Stap, n: number): string {
  const id = `resp_${n}`;
  let uit = sse("response.created", { response: { id, status: "in_progress" } });
  if ("call" in stap) {
    const item = {
      type: "function_call",
      id: `fc_${n}`,
      call_id: `call_${n}`,
      name: stap.call.name,
      ...(stap.call.namespace ? { namespace: stap.call.namespace } : {}),
      arguments: JSON.stringify(stap.call.args),
    };
    uit += sse("response.output_item.added", { output_index: 0, item }) + sse("response.output_item.done", { output_index: 0, item });
  } else {
    const item = { type: "message", id: `msg_${n}`, role: "assistant", content: [{ type: "output_text", text: stap.tekst }] };
    uit += sse("response.output_item.added", { output_index: 0, item: { ...item, content: [] } }) + sse("response.output_item.done", { output_index: 0, item });
  }
  return uit + sse("response.completed", { response: { id, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
}

export function startNep(stappen: Stap[]): Nep {
  const verzoeken: { pad: string; body: string }[] = [];
  let n = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      verzoeken.push({ pad: url.pathname, body: (await req.text()).slice(0, 300_000) });
      if (url.pathname.endsWith("/models")) return Response.json({ models: [] });
      if (!url.pathname.endsWith("/responses")) return new Response("{}", { status: 404 });
      const stap = stappen[Math.min(n, stappen.length - 1)] ?? { tekst: "klaar" };
      n++;
      return new Response(antwoord(stap, n), { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { poort: server.port ?? 0, url: `http://127.0.0.1:${server.port}/v1`, verzoeken, stop: () => void server.stop(true) };
}
