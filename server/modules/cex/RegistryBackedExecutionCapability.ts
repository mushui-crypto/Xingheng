import type { ExecutionCapability } from "./ExecutionCapability";
import type { ExecutionCapabilityRegistry } from "./ExecutionCapabilityRegistry";
import type { ExecutionIntent } from "./ExecutionIntent";

export class RegistryBackedExecutionCapability<TResult = unknown>
implements ExecutionCapability<TResult> {
  constructor(private readonly registry: Pick<ExecutionCapabilityRegistry<TResult>, "resolve">) {}

  execute(intent: ExecutionIntent): Promise<TResult> {
    return this.registry.resolve(intent.venue).execute(intent);
  }
}
