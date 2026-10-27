// De bus zoals elke schil (CLI, MCP, hooks) hem krijgt: staatmap uit de omgeving, plus de wekker.
// De wekker kiest per ontvanger op vendor en host (wekker.ts).

import { type Omgeving, staatMap } from "../hooks/register";
import { type BusMetKlaar, maakBus } from "./bus";
import { maakWekker } from "./wekker";

export function standaardBus(env: Omgeving): BusMetKlaar {
  const wekker = maakWekker({ env });
  return maakBus({ staat: staatMap(env), wekker });
}
