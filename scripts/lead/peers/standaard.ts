// De bus zoals elke schil (CLI, MCP, hooks) hem krijgt: staatmap uit de omgeving, plus de wekker.
// De wekker kiest per ontvanger op vendor en host (wekker.ts).

import { type Omgeving, staatMap } from "../hooks/register";
import { maakBus } from "./bus";
import type { Bus } from "./types";
import { maakWekker } from "./wekker";

export function standaardBus(env: Omgeving): Bus {
  const wekker = maakWekker({ env });
  return maakBus({ staat: staatMap(env), wekker });
}
