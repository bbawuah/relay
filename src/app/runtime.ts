import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { createDirectory, resolvePeer } from "../directory";
import { address } from "../directory/validation";
import { environment, type Environment } from "../environment";
import { MessageError, type Peer } from "../messages/contracts";
import { createMessageService } from "../messages/service";
import { createMessageStore } from "../storage";

export function settings(input: Environment) {
  const env = environment(input);
  const state = env.RELAY_STATE_DIR!;
  const namespace = env.RELAY_NAMESPACE!;
  address(namespace, "namespace");
  return { state, namespace, path: join(state, "messages.sqlite") };
}

export function assertMessageState(state: string) {
  for (const name of ["peers", "register"]) {
    try { lstatSync(join(state, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new MessageError("storage", "Legacy Relay state detected. Stop old writers and explicitly import with relay --state NEW_DIR migrate --source OLD_DIR --source-quiesced; keep the destination separate from the legacy root.");
  }
}

export function openRuntime(input: Environment, create = false) {
  const config = settings(input);
  assertMessageState(config.state);
  if (!create && !existsSync(config.path)) throw new MessageError("storage", "No v2 message state exists. Run relay register --name NAME first, using the same --state and --namespace.");
  const store = createMessageStore({ path: config.path });
  const directory = createDirectory({ store });
  const service = createMessageService({ store });
  return { ...config, store, directory, service, close: () => store.close() };
}

export type Runtime = ReturnType<typeof openRuntime>;

export function bindPeer(runtime: Runtime, reference: string | undefined, stableOnly = false): Peer {
  if (!reference) throw new MessageError("invalid", "An explicit --peer ID binding is required (CLI also accepts RELAY_PEER_ID).");
  address(reference, "peer binding");
  if (!stableOnly) return resolvePeer(runtime.store, runtime.namespace, reference);
  const peer = runtime.store.getPeer(runtime.namespace, reference);
  if (!peer) throw new MessageError("unknown_peer", "MCP --peer must be an existing stable peer ID in the selected namespace; aliases are not accepted.");
  return peer;
}
