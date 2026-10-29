import { MessageError, type Endpoint, type Presence } from "../messages/contracts";

export function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MessageError("invalid", `${label} must be an object`);
  }
}

/** Addresses are data, not paths. Reject missing or silently normalized identity. */
export function address(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new MessageError("invalid", `${label} must be an explicit nonempty address without surrounding whitespace or control characters`);
  }
}

export function endpoint(value: unknown): asserts value is Endpoint {
  record(value, "endpoint");
  address(value.host, "endpoint.host");
  address(value.sessionId, "endpoint.sessionId");
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
    throw new MessageError("invalid", "endpoint.generation must be a nonnegative safe integer");
  }
  record(value.target, "endpoint.target");
  for (const [key, target] of Object.entries(value.target)) {
    address(key, "endpoint.target key");
    if (typeof target !== "string") throw new MessageError("invalid", "endpoint.target values must be strings");
  }
  if (value.host === "t3" && value.target.threadId !== value.sessionId) {
    throw new MessageError("invalid", "T3 endpoint.target.threadId must equal endpoint.sessionId");
  }
}

export function presence(value: unknown): asserts value is Presence {
  if (!["online", "busy", "idle", "offline"].includes(value as string)) {
    throw new MessageError("invalid", "presence must be online, busy, idle or offline");
  }
}

export function positiveInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new MessageError("invalid", `${label} must be a positive safe integer`);
  }
}

export function timestamp(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new MessageError("invalid", "clock must return nonnegative integer milliseconds");
  return value;
}
