// De bus zoals elke schil (CLI, MCP, hooks) hem krijgt: staatmap uit de omgeving, plus de wekker.
// Spoor C vervangt alleen de regel `const wekker` door de echte wekker.

import { type Omgeving, staatMap } from "../hooks/register";
import { type BusBeheer, geenWekker, maakBus } from "./bus";

export function standaardBus(env: Omgeving): BusBeheer {
  const wekker = geenWekker;
  return maakBus({ staat: staatMap(env), wekker });
}
