import type { ExecutionCapability } from "./ExecutionCapability";
import type { ExecutionVenue } from "./ExecutionIntent";

export type RegisteredExecutionCapability<TResult = unknown> = Readonly<{
  venue: ExecutionVenue;
  capability: ExecutionCapability<TResult>;
}>;

export class ExecutionCapabilityRegistry<TResult = unknown> {
  private readonly capabilities = new Map<ExecutionVenue, ExecutionCapability<TResult>>();

  register(entry: RegisteredExecutionCapability<TResult>): this {
    if (this.capabilities.has(entry.venue)) {
      throw new Error(`Execution capability already registered for venue: ${entry.venue}.`);
    }
    this.capabilities.set(entry.venue, entry.capability);
    return this;
  }

  resolve(venue: ExecutionVenue): ExecutionCapability<TResult> {
    const capability = this.capabilities.get(venue);
    if (!capability) throw new Error(`Execution capability is not registered for venue: ${venue}.`);
    return capability;
  }

}

export function executionCapability<TResult>(
  venue: ExecutionVenue,
  capability: ExecutionCapability<TResult>,
): RegisteredExecutionCapability<TResult> {
  return Object.freeze({ venue, capability });
}
