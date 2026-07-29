import assert from "node:assert/strict";
import test from "node:test";
import { WalletService } from "./WalletService";

test("credentialless production real-test constructs without deriving or seeding", () => {
  withEnvironment(credentiallessRealTest(), () => {
    const calls = counters();
    const wallet = new WalletService(
      store(calls) as never,
      {} as never,
      onchain(calls) as never,
    );
    assert.equal(
      (wallet as unknown as { depositMnemonic: string }).depositMnemonic,
      "",
    );
    assert.deepEqual(calls, { store: 0, onchain: 0 });
  });
});

test("credentialless real-test refuses deposit derivation before dependencies", () => {
  withEnvironment(credentiallessRealTest(), () => {
    const calls = counters();
    const wallet = new WalletService(
      store(calls) as never,
      {} as never,
      onchain(calls) as never,
    );
    assert.throws(
      () => wallet.ensureDepositAddressForRegisteredUser("user-1"),
      /BSC_TESTNET_DEPOSIT_MNEMONIC/,
    );
    assert.deepEqual(calls, { store: 0, onchain: 0 });
  });
});

test("real-test rejects any present BSC secret and non-exact safe contexts", () => {
  const cases: Array<Record<string, string | undefined>> = [
    { BSC_TESTNET_DEPOSIT_MNEMONIC: "secret" },
    { BSC_TESTNET_DEPOSIT_MNEMONIC: "" },
    { BSC_TESTNET_DEPOSIT_MNEMONIC: "   " },
    { BSC_TESTNET_PRIVATE_KEY: "secret" },
    { BSC_TESTNET_PRIVATE_KEY: "" },
    { BSC_TESTNET_PRIVATE_KEY: "   " },
    { RWA_AUTOMATION_SERVER_KILL_SWITCH: "false" },
    { RWA_AUTOMATION_SERVER_KILL_SWITCH: "TRUE" },
    { NODE_ENV: "test" },
  ];
  for (const override of cases) {
    withEnvironment({ ...credentiallessRealTest(), ...override }, () => {
      const calls = counters();
      assert.throws(
        () => new WalletService(
          store(calls) as never,
          {} as never,
          onchain(calls) as never,
        ),
      );
      assert.deepEqual(calls, { store: 0, onchain: 0 });
    });
  }
});

test("production and development keep the existing mnemonic behavior", () => {
  withEnvironment({
    NODE_ENV: "production",
    XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
    RWA_AUTOMATION_SERVER_KILL_SWITCH: "true",
    BSC_TESTNET_DEPOSIT_MNEMONIC: "test mnemonic",
    BSC_TESTNET_PRIVATE_KEY: undefined,
  }, () => {
    const wallet = new WalletService(
      store(counters()) as never,
      {} as never,
      onchain(counters()) as never,
    );
    assert.equal(
      (wallet as unknown as { depositMnemonic: string }).depositMnemonic,
      "test mnemonic",
    );
  });
  withEnvironment({
    NODE_ENV: "development",
    XINGHENG_DEPLOYMENT_ENVIRONMENT: undefined,
    BSC_TESTNET_DEPOSIT_MNEMONIC: undefined,
    BSC_TESTNET_PRIVATE_KEY: undefined,
  }, () => {
    assert.throws(
      () => new WalletService(
        store(counters()) as never,
        {} as never,
        onchain(counters()) as never,
      ),
      /BSC_TESTNET_DEPOSIT_MNEMONIC/,
    );
  });
});

function credentiallessRealTest() {
  return {
    NODE_ENV: "production",
    XINGHENG_DEPLOYMENT_ENVIRONMENT: "real-test",
    RWA_AUTOMATION_SERVER_KILL_SWITCH: "true",
    BSC_TESTNET_DEPOSIT_MNEMONIC: undefined,
    BSC_TESTNET_PRIVATE_KEY: undefined,
  };
}

function counters() {
  return { store: 0, onchain: 0 };
}

function store(calls: ReturnType<typeof counters>) {
  return new Proxy({}, {
    get() {
      return () => {
        calls.store += 1;
        return null;
      };
    },
  });
}

function onchain(calls: ReturnType<typeof counters>) {
  return new Proxy({}, {
    get() {
      calls.onchain += 1;
      return undefined;
    },
  });
}

function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => void,
) {
  const before = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
