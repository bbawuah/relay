// Eén regel naar de inbox van een lead, in de vorm van de lead-hooks (hooks/register.ts:
// {"t","van","tekst"}, afgekapt op één regel < 512 B). De hooks bezorgen hem.
// Staatmap: LAB_LEAD_STAAT, anders ~/.local/state/lab-lead (het contract noemt hem LAB_LEAD_STATE; de repo gebruikt STAAT).
import { inboxMelding, staatMap } from "../hooks/register";

export function inboxRegel(lead: string, van: string, tekst: string, nu: number = Date.now()): void {
  inboxMelding(staatMap(process.env), lead, van, tekst, nu);
}
