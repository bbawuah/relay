// Kleine JSON-RPC-client voor `codex app-server` (stdio, één JSON-object per regel). Alleen wat de installer nodig heeft:
// hooks/list (welke hooks zijn er, met hash en trust-status) en config/value/write (het vertrouwen vastleggen).

export type HookInfo = { key: string; eventName: string; command: string; currentHash: string; trustStatus: "untrusted" | "trusted" | "modified" | "managed" | string };

export type AppServer = {
  hooks(cwd: string): Promise<HookInfo[]>;
  vertrouw(hashes: Record<string, string>): Promise<void>;
  sluit(): void;
};

type Antwoord = { id?: number; result?: unknown; error?: { message?: string } };

/** Start `<codex> app-server` met CODEX_HOME en doet de initialize-handshake. */
export async function startAppServer(codexBin: string, codexHome: string, cwd: string, tijdsgrensMs = 15_000): Promise<AppServer> {
  const p = Bun.spawn([codexBin, "app-server"], { env: { ...process.env, CODEX_HOME: codexHome }, stdin: "pipe", stdout: "pipe", stderr: "ignore", cwd });
  let id = 0;
  const wachtend = new Map<number, (a: Antwoord) => void>();
  void (async () => {
    let buf = "";
    const dec = new TextDecoder();
    for await (const chunk of p.stdout as unknown as AsyncIterable<Uint8Array>) {
      buf += dec.decode(chunk);
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const regel = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(regel) as Antwoord;
          if (typeof m.id === "number") wachtend.get(m.id)?.(m);
        } catch {
          // geen JSON: negeren
        }
      }
    }
  })();
  const stuur = (o: object) => {
    p.stdin.write(`${JSON.stringify(o)}\n`);
    p.stdin.flush();
  };
  const vraag = (method: string, params: object) =>
    new Promise<unknown>((klaar, faal) => {
      const n = ++id;
      const timer = setTimeout(() => faal(new Error(`codex app-server: geen antwoord op ${method} binnen ${tijdsgrensMs / 1000}s`)), tijdsgrensMs);
      wachtend.set(n, (a) => {
        clearTimeout(timer);
        wachtend.delete(n);
        if (a.error) faal(new Error(`codex app-server: ${method}: ${a.error.message ?? "fout"}`));
        else klaar(a.result);
      });
      stuur({ jsonrpc: "2.0", id: n, method, params });
    });
  try {
    await vraag("initialize", { clientInfo: { name: "lab-peerbus-installeer", version: "1" }, capabilities: {} });
  } catch (e) {
    p.kill();
    throw e;
  }
  stuur({ jsonrpc: "2.0", method: "initialized" });
  return {
    async hooks(dir) {
      const r = (await vraag("hooks/list", { cwds: [dir] })) as { data?: { hooks?: HookInfo[] }[] };
      return (r.data ?? []).flatMap((d) => d.hooks ?? []);
    },
    async vertrouw(hashes) {
      const waarde = Object.fromEntries(Object.entries(hashes).map(([k, h]) => [k, { trusted_hash: h }]));
      await vraag("config/value/write", { keyPath: "hooks.state", value: waarde, mergeStrategy: "upsert" });
    },
    sluit() {
      p.kill();
    },
  };
}
