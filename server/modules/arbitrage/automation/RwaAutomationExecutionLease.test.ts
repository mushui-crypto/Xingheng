import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RwaAutomationExecutionLease,
  RwaAutomationExecutionLeaseError,
} from "./RwaAutomationExecutionLease";
import { RwaAutomationControlService } from "./RwaAutomationControlService";
import { RwaNeutralExecutionService } from "./RwaNeutralExecutionService";
import { RwaBinanceAutomationService } from "./RwaBinanceAutomationService";

test("two execution instances compete before any registry or provider initialization", async () => {
  const fixture = leaseFixture();
  let occupied = false;
  let registryInitializations = 0;
  const acquireFd = async () => {
    if (occupied) return false;
    occupied = true;
    return true;
  };

  const first = await RwaAutomationExecutionLease.acquire({ ...fixture, acquireFd });
  await assert.rejects(
    RwaAutomationExecutionLease.acquire({ ...fixture, acquireFd }),
    (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
      && error.category === "automation_execution_lease_unavailable",
  );
  assert.equal(registryInitializations, 0);
  first.assertHeld();
  registryInitializations += 1;
  assert.equal(registryInitializations, 1);
  first.release();
  assert.throws(
    () => first.assertHeld(),
    (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
      && error.category === "automation_execution_lease_lost",
  );
});

test("failed acquisition closes its descriptor and a later owner can acquire the stale lock file", async () => {
  const fixture = leaseFixture();
  await assert.rejects(
    RwaAutomationExecutionLease.acquire({ ...fixture, acquireFd: async () => false }),
    (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
      && error.category === "automation_execution_lease_unavailable",
  );
  const recovered = await RwaAutomationExecutionLease.acquire({ ...fixture, acquireFd: async () => true });
  recovered.assertHeld();
  recovered.release();
});

test("replacing the current lock path invalidates the old owner even when its renamed inode still has one link", async () => {
  const fixture = leaseFixture();
  const first = await RwaAutomationExecutionLease.acquire({ ...fixture, acquireFd: async () => true });
  renameSync(fixture.path, join(fixture.root, "previous.lock"));
  writeFileSync(fixture.path, "", { mode: 0o600 });

  assert.throws(
    () => first.assertHeld(),
    (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
      && error.category === "automation_execution_lease_lost",
  );
  const replacement = await RwaAutomationExecutionLease.acquire({ ...fixture, acquireFd: async () => true });
  replacement.assertHeld();
  replacement.release();
  first.release();
});

test("Linux util-linux flock keeps the inherited descriptor locked until the owner releases it", {
  skip: process.platform !== "linux" && "requires Linux util-linux flock semantics",
}, async () => {
  const fixture = leaseFixture();
  const first = await RwaAutomationExecutionLease.acquire(fixture);
  await assert.rejects(
    RwaAutomationExecutionLease.acquire(fixture),
    (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
      && error.category === "automation_execution_lease_unavailable",
  );
  first.release();
  const restarted = await RwaAutomationExecutionLease.acquire(fixture);
  restarted.release();
});

test("a lost lease rejects before registry, KMS, or provider factories are reached", async () => {
  let registryCreations = 0;
  let bybitProviderCreations = 0;
  let binanceProviderCreations = 0;
  const guard = () => {
    throw new RwaAutomationExecutionLeaseError(
      "automation_execution_lease_lost",
      "自动套利执行实例租约已失效；已拒绝继续。",
    );
  };
  const control = new RwaAutomationControlService(
    {} as never,
    () => {
      registryCreations += 1;
      throw new Error("registry must not be created");
    },
    {} as never,
    undefined,
    Date.now,
    guard,
  );
  await assert.rejects(control.listVenues("user-a", "203.0.113.1"), leaseLost);
  assert.equal(registryCreations, 0);

  const store = { setClock() {} } as never;
  const bybit = new RwaNeutralExecutionService(
    store,
    (() => {
      bybitProviderCreations += 1;
      throw new Error("provider must not be created");
    }) as never,
    Date.now,
    () => false,
    guard,
  );
  await assert.rejects(bybit.putCredentials({ apiKey: "not-used", apiSecret: "not-used" }), leaseLost);
  assert.equal(bybitProviderCreations, 0);

  const binance = new RwaBinanceAutomationService(
    store,
    (() => {
      binanceProviderCreations += 1;
      throw new Error("provider must not be created");
    }) as never,
    Date.now,
    () => false,
    {} as never,
    guard,
  );
  await assert.rejects(binance.putCredentials({ apiKey: "not-used", apiSecret: "not-used" }), leaseLost);
  assert.equal(binanceProviderCreations, 0);
});

test("lease rejects unsafe lock roots, lock files, and mount topologies without leaking details", async (context) => {
  const cases: Array<[string, () => ReturnType<typeof leaseFixture>]> = [
    ["root mode", () => {
      const fixture = leaseFixture();
      chmodSync(fixture.root, 0o755);
      return fixture;
    }],
    ["root owner", () => {
      const fixture = leaseFixture();
      return { ...fixture, expectedRootUid: (process.getuid?.() ?? 0) + 1 };
    }],
    ["root symlink", () => {
      const fixture = leaseFixture();
      const alias = `${fixture.root}-alias`;
      symlinkSync(fixture.root, alias);
      return { ...fixture, root: alias, path: join(alias, "operation.lock"), mountInfo: mountInfo(alias, "ext4", "rw") };
    }],
    ["lock symlink", () => {
      const fixture = leaseFixture();
      const target = join(fixture.root, "target");
      writeFileSync(target, "", { mode: 0o600 });
      symlinkSync(target, fixture.path);
      return fixture;
    }],
    ["lock hardlink", () => {
      const fixture = leaseFixture();
      writeFileSync(fixture.path, "", { mode: 0o600 });
      linkSync(fixture.path, join(fixture.root, "other"));
      return fixture;
    }],
    ["lock mode", () => {
      const fixture = leaseFixture();
      writeFileSync(fixture.path, "", { mode: 0o644 });
      return fixture;
    }],
    ["lock owner", () => {
      const fixture = leaseFixture();
      return { ...fixture, expectedUid: (process.getuid?.() ?? 0) + 1 };
    }],
    ["read-only mount", () => {
      const fixture = leaseFixture();
      return { ...fixture, mountInfo: mountInfo(fixture.root, "ext4", "ro") };
    }],
    ["network mount", () => {
      const fixture = leaseFixture();
      return { ...fixture, mountInfo: mountInfo(fixture.root, "nfs4", "rw") };
    }],
    ["missing mount", () => {
      const fixture = leaseFixture();
      return { ...fixture, mountInfo: mountInfo("/other", "ext4", "rw") };
    }],
    ["nested mount", () => {
      const fixture = leaseFixture();
      return {
        ...fixture,
        mountInfo: `${mountInfo(fixture.root, "ext4", "rw")}${mountInfo(fixture.path, "ext4", "rw")}`,
      };
    }],
  ];

  for (const [name, create] of cases) {
    await context.test(name, async () => {
      const fixture = create();
      let flockCalls = 0;
      await assert.rejects(
        RwaAutomationExecutionLease.acquire({
          ...fixture,
          acquireFd: async () => {
            flockCalls += 1;
            return true;
          },
        }),
        (error: unknown) => {
          assert.ok(error instanceof RwaAutomationExecutionLeaseError);
          assert.equal(error.category, "automation_execution_topology_invalid");
          assert.doesNotMatch(error.message, /\/tmp|uid|gid|nfs|ext4|operation\.lock/i);
          return true;
        },
      );
      assert.equal(flockCalls, 0);
    });
  }
});

test("production topology cannot override the frozen single-host paths or runtime identity", async () => {
  const fixture = leaseFixture();
  await assert.rejects(
    RwaAutomationExecutionLease.acquire({
      ...fixture,
      production: true,
      runtimeUid: 20_001,
      runtimeGid: 20_001,
      acquireFd: async () => true,
    }),
    (error: unknown) => error instanceof RwaAutomationExecutionLeaseError
      && error.category === "automation_execution_topology_invalid",
  );
});

function leaseFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rwa-execution-lease-")));
  chmodSync(root, 0o700);
  return {
    production: false,
    root,
    path: join(root, "operation.lock"),
    mountInfo: mountInfo(root, "ext4", "rw"),
  };
}

function mountInfo(path: string, fileSystemType: string, mode: "ro" | "rw") {
  const escaped = path
    .replaceAll("\\", "\\134")
    .replaceAll(" ", "\\040")
    .replaceAll("\t", "\\011")
    .replaceAll("\n", "\\012");
  return `42 31 0:39 / ${escaped} ${mode},relatime - ${fileSystemType} source ${mode}\n`;
}

function leaseLost(error: unknown) {
  return error instanceof RwaAutomationExecutionLeaseError
    && error.category === "automation_execution_lease_lost";
}
