import assert from "node:assert/strict";
import test from "node:test";
import type { FormalExecutionRuntime } from "./FormalExecutionRuntime";
import {
  FormalExecutionRuntimeRegistry,
  FormalExecutionRuntimeRegistryError,
  formalExecutionRuntime,
} from "./FormalExecutionRuntimeRegistry";

test("resolves the runtime registered for each venue without invoking it", () => {
  const binance = runtime();
  const okx = runtime();
  const registry = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime("binance", binance))
    .register(formalExecutionRuntime("okx", okx));

  assert.equal(registry.resolve("binance"), binance);
  assert.equal(registry.resolve("okx"), okx);
  assert.equal(binance.calls, 0);
  assert.equal(okx.calls, 0);
});

test("unregistered venues fail closed before runtime or provider activity", () => {
  const binance = runtime();
  const registry = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime("binance", binance));

  assert.throws(
    () => registry.resolve("okx"),
    (error) => error instanceof FormalExecutionRuntimeRegistryError
      && error.category === "runtime_not_registered",
  );
  assert.equal(binance.calls, 0);
});

test("duplicate venue registration fails closed and preserves the first runtime", () => {
  const first = runtime();
  const second = runtime();
  const registry = new FormalExecutionRuntimeRegistry()
    .register(formalExecutionRuntime("binance", first));

  assert.throws(
    () => registry.register(formalExecutionRuntime("binance", second)),
    (error) => error instanceof FormalExecutionRuntimeRegistryError
      && error.category === "duplicate_runtime",
  );
  assert.equal(registry.resolve("binance"), first);
  assert.equal(first.calls + second.calls, 0);
});

function runtime() {
  return {
    calls: 0,
    async execute() { this.calls += 1; throw new Error("unused"); },
    async reconcile() { this.calls += 1; throw new Error("unused"); },
    async cancel() { this.calls += 1; throw new Error("unused"); },
  } satisfies FormalExecutionRuntime & { calls: number };
}
