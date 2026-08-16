import type { ExecutionVenue } from "../cex/ExecutionIntent";
import type { FormalExecutionRuntime } from "./FormalExecutionRuntime";

export type RegisteredFormalExecutionRuntime = Readonly<{
  venue: ExecutionVenue;
  runtime: FormalExecutionRuntime;
}>;

export type FormalExecutionRuntimeResolver = Readonly<{
  resolve(venue: ExecutionVenue): FormalExecutionRuntime;
}>;

export class FormalExecutionRuntimeRegistry implements FormalExecutionRuntimeResolver {
  private readonly runtimes = new Map<ExecutionVenue, FormalExecutionRuntime>();

  register(entry: RegisteredFormalExecutionRuntime): this {
    if (this.runtimes.has(entry.venue)) {
      throw new FormalExecutionRuntimeRegistryError(
        "duplicate_runtime",
        `Formal execution runtime already registered for venue: ${entry.venue}.`,
      );
    }
    this.runtimes.set(entry.venue, entry.runtime);
    return this;
  }

  resolve(venue: ExecutionVenue): FormalExecutionRuntime {
    const runtime = this.runtimes.get(venue);
    if (!runtime) {
      throw new FormalExecutionRuntimeRegistryError(
        "runtime_not_registered",
        `Formal execution runtime is not registered for venue: ${venue}.`,
      );
    }
    return runtime;
  }
}

export class FormalExecutionRuntimeRegistryError extends Error {
  constructor(
    readonly category: "duplicate_runtime" | "runtime_not_registered",
    message: string,
  ) {
    super(message);
  }
}

export function formalExecutionRuntime(
  venue: ExecutionVenue,
  runtime: FormalExecutionRuntime,
): RegisteredFormalExecutionRuntime {
  return Object.freeze({ venue, runtime });
}
