// De bus zoals elke schil (CLI, MCP, hooks) hem krijgt: staatmap uit de omgeving, plus de wekker.
// Spoor C vervangt alleen de regel `const wekker` door de echte wekker.

import { type Omgeving, staatMap } from "../hooks/register";
import { type BusMetKlaar, geenWekker, maakBus } from "./bus";

export function standaardBus(env: Omgeving): BusMetKlaar {
  const wekker = geenWekker;
  return maakBus({ staat: staatMap(env), wekker });
}
