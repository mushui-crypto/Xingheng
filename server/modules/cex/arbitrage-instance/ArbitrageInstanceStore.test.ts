import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activeManagedQuantity, managedCurrentQuantity, type NewArbitrageInstance } from "./ArbitrageInstance";
import { ArbitrageInstanceStore } from "./ArbitrageInstanceStore";
import { SqliteExecutionRecordStore } from "../ExecutionRecordStore";
import { openingSetupSourcePlanId, type ArbitrageOpeningSetup } from "../../arbitrage-execution/ArbitrageOpeningSetup";

const start = 1_800_000_000_000;

test("persists one append-only orchestration outcome per command with a production-compatible table", () => {
  withDatabase(({ dbPath }) => {
    const store = new ArbitrageInstanceStore({ dbPath });
    store.create(instance());
    const input = {
      commandId: "start-outcome-1",
      requestedByUserId: "user-a",
      arbitrageId: "arbitrage-1",
      operation: "START" as const,
      terminalStatus: "STOPPED_SAFETY",
      stopPhase: "SECOND_LEG",
      stopReason: "PROVIDER_REALITY_UNKNOWN",
      failedLegId: "short-leg",
      completedLegIds: ["long-leg"],
      currentManagedExposure: [
        { legId: "long-leg", quantity: "1" },
        { legId: "short-leg", quantity: "0" },
      ],
      mutationDisposition: "NOT_DISPATCHED" as const,
      diagnosticCategory: "POSITION_MODE_UNAVAILABLE",
      failureStage: "PRE_MUTATION",
      providerCode: "50011",
      terminalAt: start + 10,
    };
    const first = store.recordCommandOutcome("user-a", input);
    const replay = store.recordCommandOutcome("user-a", { ...input, terminalAt: start + 20 });
    assert.equal(replay.terminalAt, first.terminalAt);
    assert.deepEqual(store.listCommandOutcomesForUser("user-a"), [first]);
    assert.throws(() => store.recordCommandOutcome("user-a", {
      ...input,
      operation: "EXIT",
    }), /idempotency conflict/u);
    assert.throws(() => store.recordCommandOutcome("user-a", {
      ...input,
      commandId: "unsafe-raw-outcome",
      stopReason: "provider says secret=abc",
    }), /controlled code/u);
    assert.throws(() => store.recordCommandOutcome("user-a", {
      ...input,
      commandId: "unsafe-provider-code",
      providerCode: "51008 raw provider response",
    }), /controlled code/u);
    store.close();

    const db = new DatabaseSync(dbPath);
    try {
      const columns = db.prepare("PRAGMA table_info(arbitrage_command_outcome_audits)").all() as Array<{ name: string; type: string; notnull: number }>;
      assert.equal(columns.find(({ name }) => name === "commandId")?.type, "TEXT");
      assert.equal(columns.find(({ name }) => name === "currentManagedExposureJson")?.notnull, 1);
      assert.equal(columns.find(({ name }) => name === "mutationDisposition")?.type, "TEXT");
      assert.equal(columns.find(({ name }) => name === "diagnosticCategory")?.type, "TEXT");
      assert.equal(columns.find(({ name }) => name === "failureStage")?.type, "TEXT");
      assert.equal(columns.find(({ name }) => name === "providerCode")?.type, "TEXT");
      const audit = db.prepare(`SELECT mutationDisposition, diagnosticCategory, failureStage, providerCode
        FROM arbitrage_command_outcome_audits`).get();
      assert.equal(audit?.mutationDisposition, "NOT_DISPATCHED");
      assert.equal(audit?.diagnosticCategory, "POSITION_MODE_UNAVAILABLE");
      assert.equal(audit?.failureStage, "PRE_MUTATION");
      assert.equal(audit?.providerCode, "50011");
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM arbitrage_command_outcome_audits").get()?.count, 1);
    } finally {
      db.close();
    }
  });
});

test("adds controlled Exit disposition audit columns to the deployed legacy outcome table", () => {
  withDatabase(({ dbPath }) => {
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`CREATE TABLE arbitrage_command_outcome_audits (
      commandId TEXT PRIMARY KEY,
      requestedByUserId TEXT NOT NULL,
      arbitrageId TEXT NOT NULL,
      operation TEXT NOT NULL,
      terminalStatus TEXT NOT NULL,
      stopPhase TEXT,
      stopReason TEXT,
      failedLegId TEXT,
      completedLegIdsJson TEXT NOT NULL,
      currentManagedExposureJson TEXT NOT NULL,
      terminalAt INTEGER NOT NULL,
      businessPayloadFingerprint TEXT NOT NULL UNIQUE
    ) STRICT;`);
    legacy.close();

    const store = new ArbitrageInstanceStore({ dbPath });
    store.close();
    const migrated = new DatabaseSync(dbPath);
    try {
      const columns = new Set((migrated.prepare("PRAGMA table_info(arbitrage_command_outcome_audits)")
        .all() as Array<{ name: string }>).map(({ name }) => name));
      assert.equal(columns.has("mutationDisposition"), true);
      assert.equal(columns.has("diagnosticCategory"), true);
      assert.equal(columns.has("failureStage"), true);
      assert.equal(columns.has("providerCode"), true);
    } finally {
      migrated.close();
    }
  });
});

test("persists the original unstarted opening setup and restores it after restart", () => {
  withDatabase(({ dbPath }) => {
    const setup: ArbitrageOpeningSetup = {
      opportunityId: "op-doge",
      horizonDays: 90,
      quantityInput: { mode: "NOTIONAL_USDT", amountUsdt: "15" },
      executionMode: "EXECUTION_PRIORITY",
    };
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({ sourcePlanId: openingSetupSourcePlanId(setup) }), setup);
    first.close();

    const reopened = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(reopened.readUnstartedOpeningSetup("user-a", "arbitrage-1"), setup);
      assert.equal(reopened.readUnstartedOpeningSetup("other-user", "arbitrage-1"), null);
      reopened.claimExecutionReference("user-a", "arbitrage-1", claim("long-leg", "started-intent", start + 1));
      assert.equal(reopened.readUnstartedOpeningSetup("user-a", "arbitrage-1"), null);
    } finally {
      reopened.close();
    }
  });
});

test("seals only an identity-less legacy UNKNOWN while preserving execution facts and clearing its opening gate", async () => {
  await withAsyncDatabase(async ({ dbPath }) => {
    const store = new ArbitrageInstanceStore({ dbPath });
    const records = new SqliteExecutionRecordStore({ dbPath });
    try {
      store.create(instance());
      store.claimExecutionReference("user-a", "arbitrage-1", claim("long-leg", "legacy-intent", start + 1));
      await records.create({
        executionId: "legacy-record", intentId: "legacy-intent", userId: "user-a", venue: "okx",
        accountId: "okx:account-a", instrumentId: "XAUT-USDT-PERP", status: "UNKNOWN",
        createdAt: start + 1, updatedAt: start + 2,
      });
      store.linkExecutionRecord("user-a", "arbitrage-1", "legacy-intent", "legacy-record", start + 2);
      store.applyExecutionResult("user-a", "arbitrage-1", {
        executionIntentId: "legacy-intent", status: "UNKNOWN", confirmedQuantity: "0", updatedAt: start + 3,
      });
      const sealClaim = {
        commandId: "seal-command", operationType: "SEAL_LEGACY_UNRESOLVED_EXECUTION" as const,
        requestedByUserId: "user-a", arbitrageId: "arbitrage-1", legId: "long-leg",
        executionIntentId: "legacy-intent", executionRecordId: "legacy-record", venue: "okx" as const,
        accountId: "okx:account-a", instrumentId: "XAUT-USDT-PERP", originalStatus: "UNKNOWN" as const,
        sealStatus: "LEGACY_UNRESOLVED_MANUALLY_SEALED" as const,
        reason: "LEGACY_RECOVERY_IDENTITY_GAP" as const, businessPayloadFingerprint: "seal-fingerprint",
        sealedAt: start + 4,
      };
      const result = store.sealLegacyUnresolvedExecution("user-a", "arbitrage-1", sealClaim);
      assert.equal(result.instance.status, "CLOSED");
      assert.equal(result.instance.closedAt, start + 4);
      assert.equal(result.instance.executionReferences[0]?.status, "UNKNOWN");
      assert.equal(result.instance.executionReferences[0]?.confirmedQuantity, "0");
      assert.deepEqual(result.instance.legs.map((leg) => [leg.confirmedOpenedQuantity, leg.confirmedClosedQuantity]), [["0", "0"], ["0", "0"]]);
      assert.equal(result.instance.legacyUnresolvedExecutionSeals?.[0]?.sealStatus, "LEGACY_UNRESOLVED_MANUALLY_SEALED");
      assert.equal(store.listUnresolvedExecutionReferencesForRecovery().length, 0);
      assert.equal(store.sealLegacyUnresolvedExecution("user-a", "arbitrage-1", sealClaim).idempotentReplay, true);

      store.create(instance({ arbitrageId: "future-opening" }));
      assert.doesNotThrow(() => store.claimExecutionReference(
        "user-a", "future-opening", claim("long-leg", "future-intent", start + 5),
      ));
      const persisted = await records.loadForUser("user-a", "legacy-record");
      assert.equal(persisted?.status, "UNKNOWN");
      assert.equal(persisted?.executionAttemptId, undefined);
      assert.equal(persisted?.remoteOrderId, undefined);
    } finally {
      records.close();
      store.close();
    }
  });
});

test("creates and reads an isolated OPENING instance with exactly two legs and nullable PnL", () => {
  withStore(({ store }) => {
    const created = store.create(instance());

    assert.equal(created.status, "OPENING");
    assert.equal(created.openedAt, null);
    assert.equal(created.closedAt, null);
    assert.deepEqual(created.legs.map(({ role }) => role), ["LONG", "SHORT"]);
    assert.deepEqual(created.legs.map(managedCurrentQuantity), ["0", "0"]);
    assert.deepEqual(created.pnl, unknownPnl());
    assert.deepEqual(store.get("user-a", "arbitrage-1"), created);
    assert.equal(store.get("user-b", "arbitrage-1"), null);
  });
});

test("rejects a missing leg, duplicate role, and duplicate leg identity", () => {
  withStore(({ store }) => {
    assert.throws(
      () => store.create({ ...instance(), legs: [instance().legs[0]] } as unknown as NewArbitrageInstance),
      /exactly two legs/u,
    );
    assert.throws(
      () => store.create({
        ...instance({ arbitrageId: "arbitrage-roles" }),
        legs: [instance().legs[0], { ...instance().legs[1], role: "LONG" }],
      }),
      /one LONG leg and one SHORT leg/u,
    );
    assert.throws(
      () => store.create({
        ...instance({ arbitrageId: "arbitrage-legs" }),
        legs: [instance().legs[0], { ...instance().legs[1], legId: "long-leg" }],
      }),
      /legId values must be unique/u,
    );
  });
});

test("claims before linking and rejects reusing an executionIntentId across instances", () => {
  withStore(({ store }) => {
    store.create(instance());
    store.create(instance({ arbitrageId: "arbitrage-2" }));

    const claimed = store.claimExecutionReference("user-a", "arbitrage-1", claim("long-leg", "intent-shared", start + 1));
    assert.equal(claimed.executionReferences[0]?.status, "CLAIMED");
    assert.equal(claimed.executionReferences[0]?.executionRecordId, null);

    assert.throws(
      () => store.claimExecutionReference("user-a", "arbitrage-2", claim("long-leg", "intent-shared", start + 2)),
      /already claimed/u,
    );

    const linked = store.linkExecutionRecord(
      "user-a",
      "arbitrage-1",
      "intent-shared",
      "record-1",
      start + 2,
    );
    assert.equal(linked.executionReferences[0]?.status, "LINKED");
    assert.equal(linked.executionReferences[0]?.executionRecordId, "record-1");
  });
});

test("startup recovery candidates come only from persisted unresolved references and survive restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    const seed = (
      arbitrageId: string,
      status: "CLAIMED" | "LINKED" | "PENDING_CONFIRMATION" | "UNKNOWN" | "CONFIRMED" | "FAILED",
      createdAt: number,
    ) => {
      first.create(instance({ arbitrageId }));
      const executionIntentId = `intent-${status.toLowerCase()}`;
      first.claimExecutionReference("user-a", arbitrageId, {
        ...claim("long-leg", executionIntentId, createdAt),
      });
      if (status !== "CLAIMED") {
        first.linkExecutionRecord("user-a", arbitrageId, executionIntentId, `record-${status.toLowerCase()}`, createdAt + 1);
      }
      if (status !== "CLAIMED" && status !== "LINKED") {
        first.applyExecutionResult("user-a", arbitrageId, {
          executionIntentId,
          status,
          confirmedQuantity: status === "CONFIRMED" ? "1" : status === "FAILED" ? "0" : "0.4",
          updatedAt: createdAt + 2,
        });
      }
    };
    seed("candidate-claimed", "CLAIMED", start + 10);
    seed("candidate-linked", "LINKED", start + 20);
    seed("candidate-pending", "PENDING_CONFIRMATION", start + 30);
    seed("candidate-unknown", "UNKNOWN", start + 40);
    seed("terminal-confirmed", "CONFIRMED", start + 50);
    seed("terminal-failed", "FAILED", start + 60);
    first.close();

    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      const candidates = restarted.listUnresolvedExecutionReferencesForRecovery();
      assert.deepEqual(candidates.map(({ status }) => status), [
        "CLAIMED", "LINKED", "PENDING_CONFIRMATION", "UNKNOWN",
      ]);
      assert.deepEqual(candidates.map(({ executionIntentId }) => executionIntentId), [
        "intent-claimed", "intent-linked", "intent-pending_confirmation", "intent-unknown",
      ]);
      assert.equal(candidates[0]?.executionRecordId, null);
      assert.equal(candidates[1]?.executionRecordId, "record-linked");
      assert.deepEqual(candidates.map(({ confirmedQuantity }) => confirmedQuantity), ["0", "0", "0.4", "0.4"]);
      assert.ok(candidates.every(({ userId, venue, accountId, instrumentId, role }) =>
        userId === "user-a" && venue === "okx" && accountId === "okx:account-a"
        && instrumentId === "XAUT-USDT-PERP" && role === "LONG"));
      assert.equal(Object.isFrozen(candidates), true);
      assert.equal(Object.isFrozen(candidates[0]), true);

      restarted.create(instance({ arbitrageId: "restart-gate-target" }));
      assert.throws(
        () => restarted.claimExecutionReference(
          "user-a",
          "restart-gate-target",
          formalOpeningClaim("long-leg", "restart-gate-intent", "restart-gate-command", start + 70),
        ),
        /unresolved risk-increasing opening/u,
      );
    } finally {
      restarted.close();
    }
  });
});

test("formal OPENING claims atomically exclude duplicate legs and concurrent first-leg ownership", () => {
  withStore(({ store }) => {
    store.create(instance());
    store.claimExecutionReference("user-a", "arbitrage-1", formalOpeningClaim("long-leg", "first-intent", "first-command", start + 1));

    assert.throws(
      () => store.claimExecutionReference("user-a", "arbitrage-1",
        formalOpeningClaim("long-leg", "duplicate-intent", "duplicate-command", start + 2)),
      /unresolved risk-increasing opening|already has an opening/u,
    );
    assert.throws(
      () => store.claimExecutionReference("user-a", "arbitrage-1",
        formalOpeningClaim("short-leg", "other-first-intent", "other-first-command", start + 3)),
      /first-leg opening is not authoritatively confirmed/u,
    );
    assert.equal(store.get("user-a", "arbitrage-1")?.executionReferences.length, 1);
  });
});

test("formal unresolved opening blocks the same mutation domain across instances and terminal confirmation releases it", () => {
  withStore(({ store }) => {
    store.create(instance());
    store.create(instance({ arbitrageId: "arbitrage-2" }));
    store.claimExecutionReference("user-a", "arbitrage-1", formalOpeningClaim("long-leg", "first-intent", "first-command", start + 1));

    assert.throws(
      () => store.claimExecutionReference("user-a", "arbitrage-2",
        formalOpeningClaim("long-leg", "blocked-intent", "blocked-command", start + 2)),
      /unresolved risk-increasing opening/u,
    );
    store.linkExecutionRecord("user-a", "arbitrage-1", "first-intent", "first-record", start + 2);
    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "first-intent", status: "CONFIRMED", confirmedQuantity: "1", updatedAt: start + 3,
    });
    const allowed = store.claimExecutionReference("user-a", "arbitrage-2",
      formalOpeningClaim("long-leg", "allowed-intent", "allowed-command", start + 4));
    assert.equal(allowed.executionReferences[0]?.executionIntentId, "allowed-intent");
  });
});

test("Bitget UNKNOWN opening and closing references keep their persisted mutation gates", () => {
  withStore(({ store }) => {
    store.create(bitgetInstance());
    store.create(bitgetInstance("arbitrage-2"));
    store.claimExecutionReference(
      "user-a",
      "arbitrage-1",
      formalOpeningClaim("long-leg", "bitget-open-unknown", "bitget-open-command", start + 1),
    );
    store.linkExecutionRecord(
      "user-a", "arbitrage-1", "bitget-open-unknown", "bitget-open-record", start + 2,
    );
    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "bitget-open-unknown",
      status: "UNKNOWN",
      confirmedQuantity: "0",
      updatedAt: start + 3,
    });

    assert.throws(
      () => store.claimExecutionReference(
        "user-a",
        "arbitrage-2",
        formalOpeningClaim("long-leg", "bitget-open-blocked", "bitget-blocked-command", start + 4),
      ),
      /unresolved risk-increasing opening/u,
    );

  });

  withStore(({ store }) => {
    store.create(bitgetInstance());
    execute(store, "long-leg", "bitget-long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "bitget-short-open", "OPENING", "INCREASE", "1", start + 20);
    claimAndLink(store, "long-leg", "bitget-close-unknown", "CLOSING", "DECREASE", "1", start + 30);
    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "bitget-close-unknown",
      status: "UNKNOWN",
      confirmedQuantity: "0.4",
      updatedAt: start + 32,
    });

    assert.throws(
      () => store.claimExecutionReference(
        "user-a",
        "arbitrage-1",
        claim("long-leg", "bitget-close-blocked", start + 33, "CLOSING", "DECREASE", "0.6"),
      ),
      /unresolved closing execution/u,
    );
    const current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.executionReferences.at(-1)?.status, "UNKNOWN");
    assert.equal(current.legs[0]?.confirmedClosedQuantity, "0.4");
  });
});

test("an unresolved close keeps the same-leg mutation gate after SQLite restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    execute(first, "long-leg", "restart-long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(first, "short-leg", "restart-short-open", "OPENING", "INCREASE", "1", start + 20);
    claimAndLink(first, "long-leg", "restart-close-unknown", "CLOSING", "DECREASE", "1", start + 30);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "restart-close-unknown",
      status: "UNKNOWN",
      confirmedQuantity: "0.4",
      updatedAt: start + 32,
    });
    first.close();

    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.throws(
        () => restarted.claimExecutionReference(
          "user-a",
          "arbitrage-1",
          claim("long-leg", "restart-close-blocked", start + 33, "CLOSING", "DECREASE", "0.6"),
        ),
        /unresolved closing execution/u,
      );
      assert.equal(
        restarted.get("user-a", "arbitrage-1")?.executionReferences.at(-1)?.status,
        "UNKNOWN",
      );
    } finally {
      restarted.close();
    }
  });
});

test("restricts execution phases while allowing both adjustment quantity effects", () => {
  withStore(({ store }) => {
    store.create(instance());
    assert.throws(
      () => store.claimExecutionReference(
        "user-a",
        "arbitrage-1",
        claim("long-leg", "invalid-close", start + 1, "CLOSING", "DECREASE"),
      ),
      /does not accept CLOSING/u,
    );
    assert.throws(
      () => store.claimExecutionReference(
        "user-a",
        "arbitrage-1",
        claim("long-leg", "invalid-open", start + 1, "OPENING", "DECREASE"),
      ),
      /must increase managed exposure/u,
    );

    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "1", start + 20);
    store.claimExecutionReference(
      "user-a",
      "arbitrage-1",
      claim("long-leg", "adjust-increase", start + 30, "ADJUSTMENT", "INCREASE", "0.1"),
    );
    store.claimExecutionReference(
      "user-a",
      "arbitrage-1",
      claim("short-leg", "adjust-decrease", start + 31, "ADJUSTMENT", "DECREASE", "0.1"),
    );
  });
});

test("uses quantityEffect rather than BUY or SELL semantics for LONG and SHORT opening legs", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    let current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.status, "RESIDUAL");
    assert.equal(current.legs[0].confirmedOpenedQuantity, "1");

    // A SHORT is normally established by SELL, but its managed exposure still increases.
    execute(store, "short-leg", "short-sell-open", "OPENING", "INCREASE", "1", start + 20);
    current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.status, "HOLDING");
    assert.equal(current.legs[1].confirmedOpenedQuantity, "1");
    assert.deepEqual(current.legs.map(managedCurrentQuantity), ["1", "1"]);
    assert.equal(current.openedAt, start + 22);
  });
});

test("uses the instance-frozen residual threshold and preserves openedAt across adjustments", () => {
  withStore(({ store }) => {
    store.create(instance({ maxResidualBaseQuantity: "0.01" }));
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "0.995", start + 20);
    const firstOpenedAt = store.get("user-a", "arbitrage-1")!.openedAt;
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "HOLDING");

    execute(store, "long-leg", "long-increase", "ADJUSTMENT", "INCREASE", "0.1", start + 30);
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "RESIDUAL");
    execute(store, "short-leg", "short-increase", "ADJUSTMENT", "INCREASE", "0.1", start + 40);

    const restored = store.get("user-a", "arbitrage-1")!;
    assert.equal(restored.status, "HOLDING");
    assert.equal(restored.openedAt, firstOpenedAt);
    assert.deepEqual(restored.legs.map(managedCurrentQuantity), ["1.1", "1.095"]);
  });
});

test("keeps incomplete or unmatched exposure as RESIDUAL instead of FAILED", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "short-failed", "OPENING", "INCREASE", "1", start + 20, "FAILED", "0");

    const current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.status, "RESIDUAL");
    assert.deepEqual(current.legs.map(managedCurrentQuantity), ["1", "0"]);
  });
});

test("records a partial pending fill as managed residual exposure", () => {
  withStore(({ store }) => {
    store.create(instance());
    claimAndLink(store, "long-leg", "long-partial", "OPENING", "INCREASE", "1", start + 10);
    const partial = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-partial",
      status: "PENDING_CONFIRMATION",
      confirmedQuantity: "0.4",
      updatedAt: start + 12,
    });

    assert.equal(partial.status, "RESIDUAL");
    assert.equal(partial.legs[0].confirmedOpenedQuantity, "0.4");
    assert.equal(partial.executionReferences[0]?.status, "PENDING_CONFIRMATION");

    const replay = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-partial",
      status: "PENDING_CONFIRMATION",
      confirmedQuantity: "0.4",
      updatedAt: start + 12,
    });
    assert.equal(replay.legs[0].confirmedOpenedQuantity, "0.4");
  });
});

test("marks a terminated zero-exposure opening as FAILED and lists active/history separately", () => {
  withStore(({ store }) => {
    store.create(instance());
    store.create(instance({ arbitrageId: "arbitrage-active" }));

    execute(store, "long-leg", "long-failed", "OPENING", "INCREASE", "1", start + 10, "FAILED", "0");
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "OPENING");
    execute(store, "short-leg", "short-failed", "OPENING", "INCREASE", "1", start + 20, "FAILED", "0");
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "FAILED");
    assert.deepEqual(store.listActive("user-a").map(({ arbitrageId }) => arbitrageId), ["arbitrage-active"]);
    assert.deepEqual(store.listHistory("user-a").map(({ arbitrageId }) => arbitrageId), ["arbitrage-1"]);
  });
});

test("terminalizes only a proven first-leg NOT_DISPATCHED failure without a synthetic second reference", () => {
  withStore(({ store }) => {
    store.create(instance());
    claimAndLink(store, "long-leg", "long-not-dispatched", "OPENING", "INCREASE", "1", start + 10);
    const failed = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-not-dispatched",
      status: "FAILED",
      confirmedQuantity: "0",
      mutationDisposition: "NOT_DISPATCHED",
      updatedAt: start + 12,
    });

    assert.equal(failed.status, "FAILED");
    assert.equal(failed.executionReferences.length, 1);
    assert.equal(failed.executionReferences[0]?.legId, "long-leg");
    assert.deepEqual(failed.legs.map(managedCurrentQuantity), ["0", "0"]);
  });
});

test("does not terminalize UNKNOWN, unproven FAILED, nonzero FAILED, or an opening with a second reference", () => {
  withStore(({ store }) => {
    for (const [arbitrageId, status, quantity] of [
      ["unknown", "UNKNOWN", "0"],
      ["unproven", "FAILED", "0"],
      ["nonzero", "FAILED", "0.1"],
    ] as const) {
      store.create(instance({ arbitrageId }));
      claimAndLink(store, "long-leg", `${arbitrageId}-intent`, "OPENING", "INCREASE", "1", start + 10, arbitrageId);
      const current = store.applyExecutionResult("user-a", arbitrageId, {
        executionIntentId: `${arbitrageId}-intent`,
        status,
        confirmedQuantity: quantity,
        updatedAt: start + 12,
      });
      assert.notEqual(current.status, "FAILED", arbitrageId);
    }

    store.create(instance({ arbitrageId: "second-reference" }));
    claimAndLink(store, "long-leg", "first-intent", "OPENING", "INCREASE", "1", start + 20, "second-reference");
    store.claimExecutionReference("user-a", "second-reference", claim(
      "short-leg", "second-intent", start + 21,
    ));
    const preserved = store.applyExecutionResult("user-a", "second-reference", {
      executionIntentId: "first-intent",
      status: "FAILED",
      confirmedQuantity: "0",
      mutationDisposition: "NOT_DISPATCHED",
      updatedAt: start + 22,
    });
    assert.equal(preserved.status, "OPENING");
    assert.equal(preserved.executionReferences.length, 2);

    assert.throws(() => store.applyExecutionResult("user-a", "unknown", {
      executionIntentId: "unknown-intent",
      status: "UNKNOWN",
      confirmedQuantity: "0",
      mutationDisposition: "NOT_DISPATCHED",
      updatedAt: start + 13,
    }), /NOT_DISPATCHED proof requires/u);
  });
});

test("fails only a truly empty OPENING instance and never clears execution evidence", () => {
  withStore(({ store }) => {
    store.create(instance());
    const failed = store.failEmptyOpening("user-a", "arbitrage-1", start + 1);
    assert.equal(failed?.status, "FAILED");
    assert.equal(failed?.executionReferences.length, 0);

    store.create(instance({ arbitrageId: "arbitrage-with-reference" }));
    store.claimExecutionReference("user-a", "arbitrage-with-reference", claim(
      "long-leg",
      "unknown-opening",
      start + 2,
    ));
    const preserved = store.failEmptyOpening("user-a", "arbitrage-with-reference", start + 3);
    assert.equal(preserved, null);
    assert.equal(store.get("user-a", "arbitrage-with-reference")?.status, "OPENING");
    assert.equal(store.get("user-a", "arbitrage-with-reference")?.executionReferences.length, 1);
  });
});

test("persists empty OPENING cleanup as FAILED across restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    const failed = first.failEmptyOpening("user-a", "arbitrage-1", start + 1);
    assert.equal(failed?.status, "FAILED");
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.equal(second.get("user-a", "arbitrage-1")?.status, "FAILED");
      assert.equal(second.listActive("user-a").length, 0);
      assert.equal(second.listHistory("user-a").length, 1);
    } finally {
      second.close();
    }
  });
});

test("moves HOLDING through CLOSING to CLOSED only after both managed quantities reach zero", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "1", start + 20);
    const openedAt = store.get("user-a", "arbitrage-1")!.openedAt;

    claimAndLink(store, "long-leg", "long-close", "CLOSING", "DECREASE", "1", start + 30);
    claimAndLink(store, "short-leg", "short-close", "CLOSING", "DECREASE", "1", start + 40);
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "CLOSING");

    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-close",
      status: "CONFIRMED",
      confirmedQuantity: "1",
      updatedAt: start + 42,
    });
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "CLOSING");

    const closed = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "short-close",
      status: "CONFIRMED",
      confirmedQuantity: "1",
      updatedAt: start + 43,
    });
    assert.equal(closed.status, "CLOSED");
    assert.equal(closed.openedAt, openedAt);
    assert.equal(closed.closedAt, start + 43);
    assert.deepEqual(closed.legs.map(managedCurrentQuantity), ["0", "0"]);
    assert.deepEqual(store.listHistory("user-a").map(({ arbitrageId }) => arbitrageId), ["arbitrage-1"]);
  });
});

test("terminal FAILED opening cumulative fill is monotonic-correctable without reopening the reference", () => {
  withStore(({ store }) => {
    store.create(instance({ legs: [
      { ...instance().legs[0], plannedQuantity: "100" },
      { ...instance().legs[1], plannedQuantity: "100" },
    ] }));
    claimAndLink(store, "long-leg", "failed-open", "OPENING", "INCREASE", "100", start + 10);

    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "FAILED", confirmedQuantity: "40", updatedAt: start + 12,
    });
    const replay = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "FAILED", confirmedQuantity: "40", updatedAt: start + 13,
    });
    const corrected = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 14,
    });
    const correctedReplay = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 15,
    });
    const finalQuantityObservation = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "FAILED", confirmedQuantity: "100", updatedAt: start + 16,
    });
    const fullFillWins = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "CONFIRMED", confirmedQuantity: "100", updatedAt: start + 17,
    });

    assert.equal(replay.legs[0].confirmedOpenedQuantity, "40");
    assert.equal(corrected.legs[0].confirmedOpenedQuantity, "70");
    assert.equal(correctedReplay.legs[0].confirmedOpenedQuantity, "70");
    assert.equal(finalQuantityObservation.legs[0].confirmedOpenedQuantity, "100");
    assert.equal(fullFillWins.executionReferences[0]?.confirmedQuantity, "100");
    assert.equal(fullFillWins.executionReferences[0]?.status, "CONFIRMED");
    assert.equal(fullFillWins.status, "RESIDUAL");
    assert.throws(() => store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "CONFIRMED", confirmedQuantity: "70", updatedAt: start + 18,
    }), /cannot move backwards/u);
    assert.throws(() => store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "CONFIRMED", confirmedQuantity: "101", updatedAt: start + 19,
    }), /cannot exceed requested/u);
    assert.throws(() => store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-open", status: "FAILED", confirmedQuantity: "100", updatedAt: start + 20,
    }), /status cannot be changed/u);

    store.create(instance({ arbitrageId: "arbitrage-after-terminal" }));
    assert.doesNotThrow(() => store.claimExecutionReference(
      "user-a",
      "arbitrage-after-terminal",
      formalOpeningClaim("long-leg", "after-terminal-intent", "after-terminal-command", start + 21),
    ));
  });
});

test("terminal FAILED close correction projects only its delta and re-derives CLOSED", () => {
  withStore(({ store }) => {
    store.create(instance({ legs: [
      { ...instance().legs[0], plannedQuantity: "100" },
      { ...instance().legs[1], plannedQuantity: "100" },
    ] }));
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "100", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "100", start + 20);
    claimAndLink(store, "long-leg", "failed-close", "CLOSING", "DECREASE", "100", start + 30);
    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-close", status: "FAILED", confirmedQuantity: "40", updatedAt: start + 32,
    });
    const corrected = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-close", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 33,
    });
    assert.equal(corrected.legs[0].confirmedClosedQuantity, "70");
    assert.equal(managedCurrentQuantity(corrected.legs[0]), "30");

    execute(store, "short-leg", "short-close", "CLOSING", "DECREASE", "100", start + 40);
    const closed = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "failed-close", status: "FAILED", confirmedQuantity: "100", updatedAt: start + 50,
    });
    assert.equal(closed.legs[0].confirmedClosedQuantity, "100");
    assert.equal(closed.status, "CLOSED");
    const replay = store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
      executionIntentId: "failed-close", status: "FAILED", confirmedQuantity: "100", updatedAt: start + 51,
    });
    assert.equal(replay.status, "CLOSED");
    assert.equal(replay.legs[0].confirmedClosedQuantity, "100");
  });
});

test("CONFIRMED remains full-fill-only and terminal replay is idempotent", () => {
  withStore(({ store }) => {
    store.create(instance());
    claimAndLink(store, "long-leg", "confirmed-open", "OPENING", "INCREASE", "1", start + 10);
    assert.throws(() => store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "confirmed-open", status: "CONFIRMED", confirmedQuantity: "0.8", updatedAt: start + 12,
    }), /must equal requested/u);
    const confirmed = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "confirmed-open", status: "CONFIRMED", confirmedQuantity: "1", updatedAt: start + 13,
    });
    const replay = store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "confirmed-open", status: "CONFIRMED", confirmedQuantity: "1", updatedAt: start + 14,
    });
    assert.equal(confirmed.legs[0].confirmedOpenedQuantity, "1");
    assert.equal(replay.legs[0].confirmedOpenedQuantity, "1");
    assert.throws(() => store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "confirmed-open", status: "CONFIRMED", confirmedQuantity: "1.01", updatedAt: start + 15,
    }), /cannot exceed requested/u);
  });
});

test("Spot attribution evidence can freeze an authoritative terminal partial FAILED opening", () => {
  withStore(({ store }) => {
    store.create(instance({ strategyType: "SPOT_PERPETUAL", legs: [
      { ...instance().legs[0], venue: "binance", accountId: "binance:account-a", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "100" },
      { ...instance().legs[1], instrumentId: "DOGE-USDT-PERP", plannedQuantity: "100" },
    ] }));
    claimAndLink(store, "long-leg", "spot-failed-open", "OPENING", "INCREASE", "100", start + 10);
    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "spot-failed-open", status: "FAILED", confirmedQuantity: "40", updatedAt: start + 12,
    });
    store.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "spot-failed-open", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 13,
    });
    const evidence = store.recordSpotOpeningAttributionEvidence("user-a", {
      arbitrageId: "arbitrage-1", legId: "long-leg", executionIntentId: "spot-failed-open",
      executionRecordId: "spot-failed-open-record", attributableBaseQuantity: "39.9",
      source: "PROVIDER_ORDER_FILLS", confirmedAt: start + 14, venue: "binance",
      accountId: "binance:account-a", instrumentId: "DOGE-USDT-SPOT",
    });
    assert.equal(evidence.attributableBaseQuantity, "39.9");
    assert.equal(store.readSpotOpeningAttributionEvidence("user-a", "arbitrage-1", "long-leg").length, 1);
  });
});

test("legacy partial-CONFIRMED Spot opening is detected before immutable attribution is written", () => {
  withDatabase(({ dbPath }) => {
    const initial = new ArbitrageInstanceStore({ dbPath });
    initial.create(instance({ strategyType: "SPOT_PERPETUAL", legs: [
      { ...instance().legs[0], venue: "binance", accountId: "binance:account-a", instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "100" },
      { ...instance().legs[1], instrumentId: "DOGE-USDT-PERP", plannedQuantity: "100" },
    ] }));
    claimAndLink(initial, "long-leg", "legacy-partial-confirmed", "OPENING", "INCREASE", "100", start + 10);
    initial.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "legacy-partial-confirmed",
      status: "PENDING_CONFIRMATION",
      confirmedQuantity: "40",
      updatedAt: start + 12,
    });
    initial.close();

    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.prepare(`UPDATE arbitrage_execution_references SET status = 'CONFIRMED'
      WHERE arbitrageId = ? AND executionIntentId = ?`).run("arbitrage-1", "legacy-partial-confirmed");
    legacyDb.close();

    const reopened = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.throws(() => reopened.recordSpotOpeningAttributionEvidence("user-a", {
        arbitrageId: "arbitrage-1",
        legId: "long-leg",
        executionIntentId: "legacy-partial-confirmed",
        executionRecordId: "legacy-partial-confirmed-record",
        attributableBaseQuantity: "39.9",
        source: "PROVIDER_ORDER_FILLS",
        confirmedAt: start + 13,
        venue: "binance",
        accountId: "binance:account-a",
        instrumentId: "DOGE-USDT-SPOT",
      }), /requires authoritative terminal opening fill evidence/u);
      assert.deepEqual(reopened.readSpotOpeningAttributionEvidence("user-a", "arbitrage-1", "long-leg"), []);
    } finally {
      reopened.close();
    }
  });
});

test("CLOSED historical correction updates an existing execution while preserving the workflow lock", () => {
  withStore(({ store }) => {
    store.create(instance({ legs: [
      { ...instance().legs[0], plannedQuantity: "100" },
      { ...instance().legs[1], plannedQuantity: "100" },
    ] }));
    execute(store, "long-leg", "historical-open", "OPENING", "INCREASE", "100", start + 10, "FAILED", "40");
    execute(store, "long-leg", "known-close", "CLOSING", "DECREASE", "40", start + 20);
    const before = store.get("user-a", "arbitrage-1")!;
    assert.equal(before.status, "CLOSED");

    const corrected = store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
      executionIntentId: "historical-open", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 30,
    });

    assert.equal(corrected.status, "CLOSED");
    assert.equal(corrected.closedAt, before.closedAt);
    assert.equal(corrected.legs[0].confirmedOpenedQuantity, "70");
    assert.equal(corrected.legs[0].confirmedClosedQuantity, "40");
    assert.equal(corrected.executionReferences[0]?.confirmedQuantity, "70");
    const replay = store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
      executionIntentId: "historical-open", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 31,
    });
    assert.deepEqual(replay, corrected);
    assert.throws(() => store.claimExecutionReference(
      "user-a", "arbitrage-1", claim("long-leg", "forbidden-after-correction", start + 32, "CLOSING", "DECREASE", "30"),
    ), /Terminal arbitrage instance/u);
    assert.throws(() => store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
      executionIntentId: "historical-open", status: "FAILED", confirmedQuantity: "60", updatedAt: start + 33,
    }), /cannot move backwards/u);
    assert.throws(() => store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
      executionIntentId: "historical-open", status: "FAILED", confirmedQuantity: "101", updatedAt: start + 34,
    }), /cannot exceed requested/u);
    assert.throws(() => store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
      executionIntentId: "historical-open", status: "UNKNOWN", confirmedQuantity: "70", updatedAt: start + 35,
    }), /Terminal execution status cannot be changed/u);
    const afterUnknown = store.get("user-a", "arbitrage-1")!;
    assert.equal(afterUnknown.executionReferences[0]?.status, "FAILED");
    assert.equal(afterUnknown.executionReferences[0]?.confirmedQuantity, "70");
    assert.equal(afterUnknown.legs[0]?.confirmedOpenedQuantity, "70");
  });
});

test("FAILED historical correction updates a dispatched terminal reference without reopening lifecycle", () => {
  withDatabase(({ dbPath }) => {
    const store = new ArbitrageInstanceStore({ dbPath });
    try {
      store.create(instance({ legs: [
        { ...instance().legs[0], plannedQuantity: "100" },
        { ...instance().legs[1], plannedQuantity: "100" },
      ] }));
      execute(store, "long-leg", "legacy-failed-open", "OPENING", "INCREASE", "100", start + 10, "FAILED", "40");
      const legacyDb = new DatabaseSync(dbPath);
      legacyDb.prepare(`UPDATE arbitrage_instances SET status = 'FAILED', updatedAt = ?
        WHERE arbitrageId = ?`).run(start + 20, "arbitrage-1");
      legacyDb.close();

      const corrected = store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
        executionIntentId: "legacy-failed-open", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 30,
      });
      assert.equal(corrected.status, "FAILED");
      assert.equal(corrected.legs[0].confirmedOpenedQuantity, "70");
      assert.equal(corrected.executionReferences[0]?.status, "FAILED");
      assert.throws(() => store.claimExecutionReference(
        "user-a", "arbitrage-1", claim("short-leg", "forbidden-failed-open", start + 31),
      ), /Terminal arbitrage instance/u);
    } finally {
      store.close();
    }
  });
});

test("Management Release remains an immutable responsibility cutoff across opening correction", () => {
  withStore(({ store }) => {
    store.create(instance({ legs: [
      { ...instance().legs[0], plannedQuantity: "100" },
      { ...instance().legs[1], plannedQuantity: "100" },
    ] }));
    execute(store, "long-leg", "released-open", "OPENING", "INCREASE", "100", start + 10, "FAILED", "40");
    const released = release(store, "long-leg", "40", start + 20);

    const corrected = store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
      executionIntentId: "released-open", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 30,
    });
    assert.equal(corrected.status, "CLOSED");
    assert.equal(corrected.legs[0].confirmedOpenedQuantity, "70");
    assert.equal(activeManagedQuantity(corrected, corrected.legs[0]), "0");
    assert.deepEqual(corrected.managementReleases?.[0], released);
  });
});

test("Management Release avoids unsigned subtraction after historical close correction", () => {
  withStore(({ store }) => {
    store.create(instance({ legs: [
      { ...instance().legs[0], plannedQuantity: "100" },
      { ...instance().legs[1], plannedQuantity: "100" },
    ] }));
    execute(store, "long-leg", "released-full-open", "OPENING", "INCREASE", "100", start + 10);
    execute(store, "long-leg", "released-partial-close", "CLOSING", "DECREASE", "100", start + 20, "FAILED", "40");
    const released = release(store, "long-leg", "60", start + 30);

    const corrected = store.applyHistoricalExecutionCorrection("user-a", "arbitrage-1", {
      executionIntentId: "released-partial-close", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 40,
    });
    assert.equal(corrected.status, "CLOSED");
    assert.equal(corrected.legs[0].confirmedClosedQuantity, "70");
    assert.equal(managedCurrentQuantity(corrected.legs[0]), "30");
    assert.equal(activeManagedQuantity(corrected, corrected.legs[0]), "0");
    assert.deepEqual(corrected.managementReleases?.[0], released);
  });
});

test("rejects a DECREASE claim that would exceed this arbitrage instance's active managed exposure", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    assert.throws(
      () => claimAndLink(store, "long-leg", "bad-close", "CLOSING", "DECREASE", "2", start + 20),
      /cannot exceed active managed quantity/u,
    );
    const current = store.get("user-a", "arbitrage-1")!;
    assert.equal(current.legs[0].confirmedClosedQuantity, "0");
    assert.equal(current.executionReferences.some(({ executionIntentId }) => executionIntentId === "bad-close"), false);
  });
});

test("isolates every read and mutation by userId plus arbitrageId", () => {
  withStore(({ store }) => {
    store.create(instance());
    assert.equal(store.get("user-b", "arbitrage-1"), null);
    assert.deepEqual(store.listActive("user-b"), []);
    assert.deepEqual(store.listHistory("user-b"), []);
    assert.throws(
      () => store.claimExecutionReference("user-b", "arbitrage-1", claim("long-leg", "foreign", start + 1)),
      /not found for the authenticated user/u,
    );
    assert.throws(
      () => store.updateTargetQuantities("user-b", "arbitrage-1", [{ legId: "long-leg", plannedQuantity: "2" }], start + 1),
      /not found for the authenticated user/u,
    );
    store.claimExecutionReference("user-a", "arbitrage-1", claim("long-leg", "owned-intent", start + 1));
    assert.throws(
      () => store.linkExecutionRecord("user-b", "arbitrage-1", "owned-intent", "foreign-record", start + 2),
      /not found for the authenticated user/u,
    );
    assert.throws(
      () => store.applyExecutionResult("user-b", "arbitrage-1", {
        executionIntentId: "owned-intent",
        status: "FAILED",
        confirmedQuantity: "0",
        updatedAt: start + 2,
      }),
      /not found for the authenticated user/u,
    );
    assert.throws(
      () => store.updateCumulativeReturns("user-b", "arbitrage-1", unknownPnl(), start + 2),
      /not found for the authenticated user/u,
    );
    assert.equal(store.get("user-a", "arbitrage-1")?.executionReferences.length, 1);
    assert.equal(store.get("user-a", "arbitrage-1")?.executionReferences[0]?.executionRecordId, null);
  });
});

test("updates target quantities without creating a new arbitrage instance", () => {
  withStore(({ store }) => {
    store.create(instance());
    const updated = store.updateTargetQuantities("user-a", "arbitrage-1", [
      { legId: "long-leg", plannedQuantity: "1.2" },
      { legId: "short-leg", plannedQuantity: "1.2" },
    ], start + 1);

    assert.equal(updated.arbitrageId, "arbitrage-1");
    assert.deepEqual(updated.legs.map(({ plannedQuantity }) => plannedQuantity), ["1.2", "1.2"]);
  });
});

test("atomically attributes first-leg exposure and freezes a non-overshooting second-leg hedge", () => {
  withStore(({ store }) => {
    store.create(instance());
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);

    const prepared = store.prepareSecondLegHedge("user-a", "arbitrage-1", {
      firstExecutionIntentId: "long-open",
      secondLegId: "short-leg",
      targetBaseQuantity: "0.95",
      executableBaseQuantity: "0.9",
      updatedAt: start + 13,
    });
    const replay = store.prepareSecondLegHedge("user-a", "arbitrage-1", {
      firstExecutionIntentId: "long-open",
      secondLegId: "short-leg",
      targetBaseQuantity: "0.95",
      executableBaseQuantity: "0.9",
      updatedAt: start + 13,
    });

    assert.equal(prepared.legs[0].confirmedOpenedQuantity, "0.95");
    assert.equal(prepared.legs[0].plannedQuantity, "0.95");
    assert.equal(prepared.legs[1].plannedQuantity, "0.9");
    assert.equal(prepared.maxResidualBaseQuantity, "0.05");
    assert.deepEqual(
      store.readPreparedSecondLegHedge("user-a", "arbitrage-1", "long-open", "short-leg"),
      { targetBaseQuantity: "0.95", executableBaseQuantity: "0.9", residualBaseQuantity: "0.05" },
    );
    assert.deepEqual(replay, prepared);
    assert.throws(
      () => store.prepareSecondLegHedge("user-a", "arbitrage-1", {
        firstExecutionIntentId: "long-open",
        secondLegId: "short-leg",
        targetBaseQuantity: "0.95",
        executableBaseQuantity: "0.8",
        updatedAt: start + 30,
      }),
      /already frozen/u,
    );
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "0.9", start + 20);
    assert.equal(store.get("user-a", "arbitrage-1")?.status, "HOLDING");
    assert.throws(
      () => store.prepareSecondLegHedge("user-a", "arbitrage-1", {
        firstExecutionIntentId: "long-open",
        secondLegId: "short-leg",
        targetBaseQuantity: "0.9",
        executableBaseQuantity: "1",
        updatedAt: start + 30,
      }),
      /cannot exceed/u,
    );
  });
});

test("restores the same prepared hedge target and residual after restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    const prepared = first.prepareSecondLegHedge("user-a", "arbitrage-1", {
      firstExecutionIntentId: "long-open",
      secondLegId: "short-leg",
      targetBaseQuantity: "0.95",
      executableBaseQuantity: "0.9",
      updatedAt: start + 13,
    });
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(second.get("user-a", "arbitrage-1"), prepared);
      assert.deepEqual(
        second.readPreparedSecondLegHedge("user-a", "arbitrage-1", "long-open", "short-leg"),
        { targetBaseQuantity: "0.95", executableBaseQuantity: "0.9", residualBaseQuantity: "0.05" },
      );
    } finally {
      second.close();
    }
  });
});

test("restores CLOSED lifecycle, quantities, references, timestamps, and nullable PnL after restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "1", start + 10);
    execute(first, "short-leg", "short-open", "OPENING", "INCREASE", "1", start + 20);
    first.updateCumulativeReturns("user-a", "arbitrage-1", unknownPnl(), start + 30);
    claimAndLink(first, "long-leg", "long-close", "CLOSING", "DECREASE", "1", start + 40);
    claimAndLink(first, "short-leg", "short-close", "CLOSING", "DECREASE", "1", start + 50);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-close",
      status: "CONFIRMED",
      confirmedQuantity: "1",
      updatedAt: start + 52,
    });
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "short-close",
      status: "CONFIRMED",
      confirmedQuantity: "1",
      updatedAt: start + 53,
    });
    const expected = first.get("user-a", "arbitrage-1");
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      const restored = second.get("user-a", "arbitrage-1");
      assert.deepEqual(restored, expected);
      assert.equal(restored?.status, "CLOSED");
      assert.equal(restored?.openedAt, start + 22);
      assert.equal(restored?.closedAt, start + 53);
      assert.deepEqual(restored?.pnl, unknownPnl());
      assert.equal(restored?.executionReferences.length, 4);
    } finally {
      second.close();
    }
  });
});

test("persists an accepted close safety residual without claiming Active Managed is closed", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({
      strategyType: "SPOT_PERPETUAL",
      legs: [
        { ...instance().legs[0], instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "73" },
        { ...instance().legs[1], plannedQuantity: "73" },
      ],
    }));
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "73", start + 10);
    execute(first, "short-leg", "short-open", "OPENING", "INCREASE", "73", start + 20);
    first.claimExecutionReference("user-a", "arbitrage-1", {
      ...claim("long-leg", "long-close", start + 30, "CLOSING", "DECREASE", "72"),
      acceptedResidualQuantity: "1",
    });
    first.linkExecutionRecord("user-a", "arbitrage-1", "long-close", "long-close-record", start + 31);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-close", status: "CONFIRMED", confirmedQuantity: "72", updatedAt: start + 32,
    });
    execute(first, "short-leg", "short-close", "CLOSING", "DECREASE", "73", start + 40);
    const expected = first.get("user-a", "arbitrage-1");
    assert.equal(expected?.status, "RESIDUAL");
    assert.equal(expected?.maxResidualBaseQuantity, "1");
    assert.deepEqual(expected?.legs.map(managedCurrentQuantity), ["1", "0"]);
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(second.get("user-a", "arbitrage-1"), expected);
    } finally {
      second.close();
    }
  });
});

test("clears the initial planned mismatch tolerance before terminalization unless Spot residual is audited", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({
      strategyType: "SPOT_PERPETUAL",
      maxResidualBaseQuantity: "1",
      legs: [
        { ...instance().legs[0], instrumentId: "BTC-USDT-SPOT", plannedQuantity: "73" },
        { ...instance().legs[1], instrumentId: "BTC-USDT-PERP", plannedQuantity: "72" },
      ],
    }));
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "73", start + 10);
    execute(first, "short-leg", "short-open", "OPENING", "INCREASE", "72", start + 20);
    assert.equal(first.get("user-a", "arbitrage-1")?.status, "HOLDING");
    assert.equal(first.get("user-a", "arbitrage-1")?.maxResidualBaseQuantity, "1");

    execute(first, "long-leg", "long-close", "CLOSING", "DECREASE", "72", start + 30);
    execute(first, "short-leg", "short-close", "CLOSING", "DECREASE", "72", start + 40);
    const expected = first.get("user-a", "arbitrage-1");
    assert.equal(expected?.maxResidualBaseQuantity, "0");
    assert.equal(expected?.status, "RESIDUAL");
    assert.deepEqual(expected?.legs.map(managedCurrentQuantity), ["1", "0"]);
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(second.get("user-a", "arbitrage-1"), expected);
      assert.equal(second.get("user-a", "arbitrage-1")?.status, "RESIDUAL");
    } finally {
      second.close();
    }
  });
});

test("never applies an accepted Spot residual allowance to a perpetual residual, including after restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({
      strategyType: "SPOT_PERPETUAL",
      legs: [
        { ...instance().legs[0], instrumentId: "DOGE-USDT-SPOT", plannedQuantity: "73" },
        { ...instance().legs[1], instrumentId: "DOGE-USDT-PERP", plannedQuantity: "73" },
      ],
    }));
    execute(first, "long-leg", "long-open", "OPENING", "INCREASE", "73", start + 10);
    execute(first, "short-leg", "short-open", "OPENING", "INCREASE", "73", start + 20);
    first.claimExecutionReference("user-a", "arbitrage-1", {
      ...claim("long-leg", "long-close", start + 30, "CLOSING", "DECREASE", "72"),
      acceptedResidualQuantity: "1",
    });
    first.linkExecutionRecord("user-a", "arbitrage-1", "long-close", "long-close-record", start + 31);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "long-close", status: "CONFIRMED", confirmedQuantity: "72", updatedAt: start + 32,
    });
    execute(first, "short-leg", "short-close", "CLOSING", "DECREASE", "73", start + 40, "FAILED", "72");
    const expected = first.get("user-a", "arbitrage-1");
    assert.equal(expected?.status, "RESIDUAL");
    assert.equal(expected?.maxResidualBaseQuantity, "1");
    assert.deepEqual(expected?.legs.map(managedCurrentQuantity), ["1", "1"]);
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(second.get("user-a", "arbitrage-1"), expected);
      assert.equal(second.get("user-a", "arbitrage-1")?.status, "RESIDUAL");
    } finally {
      second.close();
    }
  });
});

test("never closes a perpetual-perpetual instance while either perpetual leg has residual exposure", () => {
  withStore(({ store }) => {
    store.create(instance({ maxResidualBaseQuantity: "1", legs: [
      { ...instance().legs[0], plannedQuantity: "73" },
      { ...instance().legs[1], plannedQuantity: "73" },
    ] }));
    execute(store, "long-leg", "long-open", "OPENING", "INCREASE", "73", start + 10);
    execute(store, "short-leg", "short-open", "OPENING", "INCREASE", "73", start + 20);
    execute(store, "long-leg", "long-close", "CLOSING", "DECREASE", "73", start + 30, "FAILED", "72");
    execute(store, "short-leg", "short-close", "CLOSING", "DECREASE", "73", start + 40);

    const result = store.get("user-a", "arbitrage-1");
    assert.equal(result?.status, "RESIDUAL");
    assert.deepEqual(result?.legs.map(managedCurrentQuantity), ["1", "0"]);
  });
});

test("restores an unfinished execution claim after restart without relying on memory", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    first.claimExecutionReference("user-a", "arbitrage-1", claim("long-leg", "interrupted-intent", start + 1));
    first.close();

    const second = new ArbitrageInstanceStore({ dbPath });
    try {
      const restored = second.get("user-a", "arbitrage-1")!;
      assert.deepEqual(restored.executionReferences, [{
        arbitrageId: "arbitrage-1",
        legId: "long-leg",
        phase: "OPENING",
        quantityEffect: "INCREASE",
        executionIntentId: "interrupted-intent",
        executionRecordId: null,
        requestedQuantity: "1",
        confirmedQuantity: "0",
        status: "CLAIMED",
        createdAt: start + 1,
        updatedAt: start + 1,
      }]);
      assert.equal(restored.status, "OPENING");
    } finally {
      second.close();
    }
  });
});

test("real SQLITE_BUSY before an opening claim fails closed without a persisted exposure or Provider mutation", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    const lock = new DatabaseSync(dbPath);
    let providerMutations = 0;
    try {
      lock.exec("BEGIN IMMEDIATE");
      assert.throws(
        () => first.claimExecutionReference(
          "user-a",
          "arbitrage-1",
          formalOpeningClaim("long-leg", "busy-intent", "busy-command", start + 1),
        ),
        /database is locked/u,
      );
      assert.equal(providerMutations, 0);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      first.close();
    }

    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      const persisted = restarted.get("user-a", "arbitrage-1");
      assert.deepEqual(persisted?.executionReferences, []);
      assert.deepEqual(persisted?.legs.map(managedCurrentQuantity), ["0", "0"]);
      assert.equal(providerMutations, 0);
    } finally {
      restarted.close();
    }
  });
});

for (const injectedFailure of ["SQLITE_FULL", "SQLITE_IOERR"] as const) {
  test(`${injectedFailure} at the opening-claim write boundary fails closed`, () => {
    withDatabase(({ dbPath }) => {
      const seeded = new ArbitrageInstanceStore({ dbPath });
      seeded.create(instance());
      seeded.close();
      const injector = new DatabaseSync(dbPath);
      injector.exec(`CREATE TRIGGER inject_claim_failure BEFORE INSERT ON arbitrage_execution_references
        BEGIN SELECT RAISE(ABORT, '${injectedFailure} injected'); END`);
      injector.close();

      const store = new ArbitrageInstanceStore({ dbPath });
      let providerMutations = 0;
      try {
        assert.throws(
          () => store.claimExecutionReference(
            "user-a",
            "arbitrage-1",
            formalOpeningClaim("long-leg", `${injectedFailure}-intent`, `${injectedFailure}-command`, start + 1),
          ),
          new RegExp(injectedFailure, "u"),
        );
        assert.equal(store.get("user-a", "arbitrage-1")?.executionReferences.length, 0);
        assert.equal(providerMutations, 0);
      } finally {
        store.close();
      }
    });
  });
}

test("a persisted opening claim survives a post-dispatch projection BUSY and converges delta-only after restart", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({ legs: [
      { ...instance().legs[0], plannedQuantity: "100" },
      instance().legs[1],
    ] }));
    claimAndLink(first, "long-leg", "post-dispatch", "OPENING", "INCREASE", "100", start + 1);
    const lock = new DatabaseSync(dbPath);
    let providerMutations = 1;
    try {
      lock.exec("BEGIN IMMEDIATE");
      assert.throws(() => first.applyExecutionResult("user-a", "arbitrage-1", {
        executionIntentId: "post-dispatch",
        status: "UNKNOWN",
        confirmedQuantity: "40",
        updatedAt: start + 3,
      }), /database is locked/u);
    } finally {
      lock.exec("ROLLBACK");
      lock.close();
      first.close();
    }

    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      const candidate = restarted.listUnresolvedExecutionReferencesForRecovery();
      assert.equal(candidate.length, 1);
      assert.equal(candidate[0]?.executionIntentId, "post-dispatch");
      assert.equal(candidate[0]?.status, "LINKED");
      assert.equal(candidate[0]?.confirmedQuantity, "0");
      assert.equal(providerMutations, 1);

      for (const [status, quantity, expected] of [
        ["UNKNOWN", "40", "40"],
        ["UNKNOWN", "70", "70"],
        ["UNKNOWN", "70", "70"],
        ["CONFIRMED", "100", "100"],
      ] as const) {
        restarted.applyExecutionResult("user-a", "arbitrage-1", {
          executionIntentId: "post-dispatch",
          status,
          confirmedQuantity: quantity,
          updatedAt: start + 10 + Number(quantity),
        });
        assert.equal(
          restarted.get("user-a", "arbitrage-1")?.legs[0]?.confirmedOpenedQuantity,
          expected,
        );
      }
      assert.equal(providerMutations, 1);
    } finally {
      restarted.close();
    }
  });
});

test("UNKNOWN with a known cumulative lower bound survives shutdown and reopen without becoming zero", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({ legs: [
      { ...instance().legs[0], plannedQuantity: "100" },
      instance().legs[1],
    ] }));
    claimAndLink(first, "long-leg", "unknown-lower-bound", "OPENING", "INCREASE", "100", start + 1);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "unknown-lower-bound",
      status: "UNKNOWN",
      confirmedQuantity: "40",
      updatedAt: start + 3,
    });
    first.close();

    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      const restored = restarted.get("user-a", "arbitrage-1");
      assert.equal(restored?.executionReferences[0]?.status, "UNKNOWN");
      assert.equal(restored?.executionReferences[0]?.confirmedQuantity, "40");
      assert.equal(restored?.legs[0]?.confirmedOpenedQuantity, "40");
      assert.equal(restarted.listUnresolvedExecutionReferencesForRecovery()[0]?.confirmedQuantity, "40");
    } finally {
      restarted.close();
    }
  });
});

test("an interrupted index migration is safely recreated on restart without changing execution facts", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance());
    claimAndLink(first, "long-leg", "index-migration-fact", "OPENING", "INCREASE", "1", start + 1);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "index-migration-fact",
      status: "UNKNOWN",
      confirmedQuantity: "0.4",
      updatedAt: start + 3,
    });
    first.close();
    const interrupted = new DatabaseSync(dbPath);
    interrupted.exec("DROP INDEX arbitrage_instances_user_status_created");
    interrupted.close();

    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      const restored = restarted.get("user-a", "arbitrage-1");
      assert.equal(restored?.executionReferences[0]?.status, "UNKNOWN");
      assert.equal(restored?.executionReferences[0]?.confirmedQuantity, "0.4");
      assert.equal(restored?.legs[0]?.confirmedOpenedQuantity, "0.4");
      const inspect = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal((inspect.prepare(`SELECT count(*) AS count FROM sqlite_master
          WHERE type = 'index' AND name = 'arbitrage_instances_user_status_created'`).get() as { count: number }).count, 1);
      } finally {
        inspect.close();
      }
    } finally {
      restarted.close();
    }
  });
});

test("persists immutable Spot opening attribution evidence bound to a confirmed reference", () => {
  withDatabase(({ dbPath }) => {
    const first = new ArbitrageInstanceStore({ dbPath });
    first.create(instance({
      strategyType: "SPOT_PERPETUAL",
      legs: [
        { ...instance().legs[0], venue: "binance", accountId: "binance:account-a", instrumentId: "XAUT-USDT-SPOT" },
        instance().legs[1],
      ],
    }));
    claimAndLink(first, "long-leg", "spot-open", "OPENING", "INCREASE", "100", start + 1);
    const evidence = {
      arbitrageId: "arbitrage-1", legId: "long-leg", executionIntentId: "spot-open",
      executionRecordId: "spot-open-record", attributableBaseQuantity: "99.9",
      source: "PROVIDER_ORDER_FILLS" as const, confirmedAt: start + 4,
      venue: "binance" as const, accountId: "binance:account-a", instrumentId: "XAUT-USDT-SPOT",
    };
    assert.throws(
      () => first.recordSpotOpeningAttributionEvidence("user-a", evidence),
      /authoritative terminal opening fill evidence/u,
    );
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "spot-open", status: "CONFIRMED", confirmedQuantity: "100", updatedAt: start + 3,
    });
    assert.deepEqual(first.recordSpotOpeningAttributionEvidence("user-a", evidence), evidence);
    assert.deepEqual(
      first.recordSpotOpeningAttributionEvidence("user-a", { ...evidence, confirmedAt: start + 10 }),
      evidence,
    );
    assert.throws(
      () => first.recordSpotOpeningAttributionEvidence("user-a", { ...evidence, attributableBaseQuantity: "99.8" }),
      /immutable/u,
    );
    assert.deepEqual(first.readSpotOpeningAttributionEvidence("user-b", "arbitrage-1", "long-leg"), []);
    first.close();

    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(restarted.readSpotOpeningAttributionEvidence("user-a", "arbitrage-1", "long-leg"), [evidence]);
    } finally {
      restarted.close();
    }
  });
});

test("Spot attribution and its recovery audit roll back together when the audit write fails", () => {
  withDatabase(({ dbPath }) => {
    const seeded = new ArbitrageInstanceStore({ dbPath });
    seeded.create(instance({
      strategyType: "SPOT_PERPETUAL",
      legs: [
        { ...instance().legs[0], venue: "binance", accountId: "binance:account-a", instrumentId: "XAUT-USDT-SPOT" },
        instance().legs[1],
      ],
    }));
    claimAndLink(seeded, "long-leg", "spot-audit-failure", "OPENING", "INCREASE", "100", start + 1);
    seeded.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "spot-audit-failure", status: "CONFIRMED",
      confirmedQuantity: "100", updatedAt: start + 3,
    });
    seeded.close();

    const injector = new DatabaseSync(dbPath);
    injector.exec(`CREATE TRIGGER inject_spot_audit_failure BEFORE INSERT ON arbitrage_recovery_audit
      BEGIN SELECT RAISE(ABORT, 'SQLITE_IOERR injected audit failure'); END`);
    injector.close();
    const evidence = {
      arbitrageId: "arbitrage-1", legId: "long-leg", executionIntentId: "spot-audit-failure",
      executionRecordId: "spot-audit-failure-record", attributableBaseQuantity: "99.9",
      source: "PROVIDER_ORDER_FILLS" as const, confirmedAt: start + 4,
      venue: "binance" as const, accountId: "binance:account-a", instrumentId: "XAUT-USDT-SPOT",
    };
    const failed = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.throws(() => failed.recordSpotOpeningAttributionEvidence("user-a", evidence, {
        recoveryId: "spot-recovery-1", actorId: "operator-a", checkedAt: start + 4,
      }), /SQLITE_IOERR/u);
      assert.deepEqual(failed.readSpotOpeningAttributionEvidence("user-a", "arbitrage-1", "long-leg"), []);
    } finally {
      failed.close();
    }

    const repair = new DatabaseSync(dbPath);
    repair.exec("DROP TRIGGER inject_spot_audit_failure");
    repair.close();
    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.deepEqual(restarted.recordSpotOpeningAttributionEvidence("user-a", evidence, {
        recoveryId: "spot-recovery-1", actorId: "operator-a", checkedAt: start + 4,
      }), evidence);
      assert.deepEqual(
        restarted.recordSpotOpeningAttributionEvidence("user-a", { ...evidence, confirmedAt: start + 10 }),
        evidence,
      );
      assert.throws(
        () => restarted.recordSpotOpeningAttributionEvidence("user-a", {
          ...evidence, attributableBaseQuantity: "99.8",
        }),
        /immutable/u,
      );
    } finally {
      restarted.close();
    }
  });
});

test("Management Release rolls back evidence, fingerprint, and lifecycle together on a mid-transaction failure", () => {
  withDatabase(({ dbPath }) => {
    const seeded = new ArbitrageInstanceStore({ dbPath });
    seeded.create(instance());
    execute(seeded, "long-leg", "release-open", "OPENING", "INCREASE", "1", start + 1);
    seeded.close();

    const injector = new DatabaseSync(dbPath);
    injector.exec(`CREATE TRIGGER inject_release_lifecycle_failure BEFORE UPDATE ON arbitrage_instances
      BEGIN SELECT RAISE(ABORT, 'SQLITE_FULL injected lifecycle failure'); END`);
    injector.close();
    const failed = new ArbitrageInstanceStore({ dbPath });
    try {
      assert.throws(() => release(failed, "long-leg", "1", start + 10), /SQLITE_FULL/u);
      const unchanged = failed.get("user-a", "arbitrage-1");
      assert.deepEqual(unchanged?.managementReleases, []);
      assert.equal(unchanged?.legs[0] && activeManagedQuantity(unchanged, unchanged.legs[0]), "1");
      assert.notEqual(unchanged?.status, "CLOSED");
    } finally {
      failed.close();
    }

    const inspect = new DatabaseSync(dbPath);
    assert.equal((inspect.prepare("SELECT count(*) AS count FROM arbitrage_command_idempotency WHERE commandId = ?")
      .get("release-command-long-leg") as { count: number }).count, 0);
    inspect.exec("DROP TRIGGER inject_release_lifecycle_failure");
    inspect.close();
    const restarted = new ArbitrageInstanceStore({ dbPath });
    try {
      const result = release(restarted, "long-leg", "1", start + 10);
      assert.equal(result.releasedQuantity, "1");
      const persisted = restarted.get("user-a", "arbitrage-1")!;
      assert.equal(activeManagedQuantity(persisted, persisted.legs[0]), "0");
    } finally {
      restarted.close();
    }

    const finalRestart = new ArbitrageInstanceStore({ dbPath });
    try {
      const durable = finalRestart.get("user-a", "arbitrage-1");
      assert.equal(durable?.managementReleases?.length, 1);
      assert.equal(durable?.legs[0] && activeManagedQuantity(durable, durable.legs[0]), "0");
    } finally {
      finalRestart.close();
    }
  });
});

test("concurrent terminal cumulative projections converge without double-counting or stale overwrite", async () => {
  const root = mkdtempSync(join(tmpdir(), "arbitrage-instance-store-concurrent-terminal-"));
  const dbPath = join(root, "arbitrage-instances.sqlite");
  const first = new ArbitrageInstanceStore({ dbPath });
  const second = new ArbitrageInstanceStore({ dbPath });
  try {
    first.create(instance());
    claimAndLink(first, "long-leg", "terminal-race", "OPENING", "INCREASE", "100", start + 1);
    first.applyExecutionResult("user-a", "arbitrage-1", {
      executionIntentId: "terminal-race", status: "FAILED", confirmedQuantity: "40", updatedAt: start + 3,
    });

    let releaseEqual!: () => void;
    const equalGate = new Promise<void>((resolve) => { releaseEqual = resolve; });
    const equalProjection = (store: ArbitrageInstanceStore) => (async () => {
      await equalGate;
      return store.applyExecutionResult("user-a", "arbitrage-1", {
        executionIntentId: "terminal-race", status: "FAILED", confirmedQuantity: "70", updatedAt: start + 4,
      });
    })();
    const equalLeft = equalProjection(first);
    const equalRight = equalProjection(second);
    releaseEqual();
    await Promise.all([equalLeft, equalRight]);
    assert.equal(first.get("user-a", "arbitrage-1")?.legs[0]?.confirmedOpenedQuantity, "70");

    let releaseOrdered!: () => void;
    const orderedGate = new Promise<void>((resolve) => { releaseOrdered = resolve; });
    const project = (
      store: ArbitrageInstanceStore,
      status: "CONFIRMED" | "FAILED",
      confirmedQuantity: string,
      updatedAt: number,
    ) => (async () => {
      await orderedGate;
      return store.applyExecutionResult("user-a", "arbitrage-1", {
        executionIntentId: "terminal-race", status, confirmedQuantity, updatedAt,
      });
    })();
    const newer = project(first, "CONFIRMED", "100", start + 6);
    const stale = project(second, "FAILED", "70", start + 5);
    releaseOrdered();
    const outcomes = await Promise.allSettled([newer, stale]);

    assert.equal(outcomes[0]?.status, "fulfilled");
    if (outcomes[1]?.status === "rejected") {
      assert.match(String(outcomes[1].reason), /move backwards|status cannot be changed/u);
    }
    const converged = second.get("user-a", "arbitrage-1")!;
    assert.equal(converged.legs[0]?.confirmedOpenedQuantity, "100");
    assert.equal(converged.executionReferences[0]?.confirmedQuantity, "100");
    assert.equal(converged.executionReferences[0]?.status, "CONFIRMED");
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function instance(overrides: Partial<NewArbitrageInstance> = {}): NewArbitrageInstance {
  return {
    arbitrageId: "arbitrage-1",
    userId: "user-a",
    strategyType: "PERPETUAL_PERPETUAL",
    sourcePlanId: "plan-1",
    maxResidualBaseQuantity: "0",
    createdAt: start,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: "okx",
        accountId: "okx:account-a",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "binance",
        accountId: "binance:account-a",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
      },
    ],
    ...overrides,
  };
}

function bitgetInstance(arbitrageId = "arbitrage-1"): NewArbitrageInstance {
  return instance({
    arbitrageId,
    legs: [
      {
        legId: "long-leg",
        role: "LONG",
        venue: "bitget",
        accountId: "bitget:account-a",
        instrumentId: "XAUT-USDT-PERP",
        plannedQuantity: "1",
      },
      {
        legId: "short-leg",
        role: "SHORT",
        venue: "bitget",
        accountId: "bitget:account-a",
        instrumentId: "BTC-USDT-PERP",
        plannedQuantity: "1",
      },
    ],
  });
}

function claim(
  legId: string,
  executionIntentId: string,
  createdAt: number,
  phase: "OPENING" | "ADJUSTMENT" | "CLOSING" = "OPENING",
  quantityEffect: "INCREASE" | "DECREASE" = "INCREASE",
  requestedQuantity = "1",
) {
  return { legId, phase, quantityEffect, executionIntentId, requestedQuantity, createdAt } as const;
}

function formalOpeningClaim(legId: string, executionIntentId: string, commandId: string, createdAt: number) {
  return {
    legId,
    phase: "OPENING" as const,
    quantityEffect: "INCREASE" as const,
    executionIntentId,
    requestedQuantity: "1",
    commandId,
    operationType: "EXECUTION_OPEN" as const,
    businessPayloadFingerprint: `opening-fingerprint-${commandId}`,
    createdAt,
  };
}

function claimAndLink(
  store: ArbitrageInstanceStore,
  legId: string,
  executionIntentId: string,
  phase: "OPENING" | "ADJUSTMENT" | "CLOSING",
  quantityEffect: "INCREASE" | "DECREASE",
  requestedQuantity: string,
  time: number,
  arbitrageId = "arbitrage-1",
) {
  store.claimExecutionReference(
    "user-a",
    arbitrageId,
    claim(legId, executionIntentId, time, phase, quantityEffect, requestedQuantity),
  );
  store.linkExecutionRecord(
    "user-a",
    arbitrageId,
    executionIntentId,
    `${executionIntentId}-record`,
    time + 1,
  );
}

function execute(
  store: ArbitrageInstanceStore,
  legId: string,
  executionIntentId: string,
  phase: "OPENING" | "ADJUSTMENT" | "CLOSING",
  quantityEffect: "INCREASE" | "DECREASE",
  requestedQuantity: string,
  time: number,
  status: "PENDING_CONFIRMATION" | "CONFIRMED" | "FAILED" | "UNKNOWN" = "CONFIRMED",
  confirmedQuantity = requestedQuantity,
) {
  claimAndLink(store, legId, executionIntentId, phase, quantityEffect, requestedQuantity, time);
  return store.applyExecutionResult("user-a", "arbitrage-1", {
    executionIntentId,
    status,
    confirmedQuantity,
    updatedAt: time + 2,
  });
}

function release(
  store: ArbitrageInstanceStore,
  legId: string,
  releasedQuantity: string,
  at: number,
) {
  const current = store.get("user-a", "arbitrage-1")!;
  const leg = current.legs.find((candidate) => candidate.legId === legId)!;
  return store.releaseLegManagement("user-a", "arbitrage-1", {
    releaseId: `release-${legId}`,
    commandId: `release-command-${legId}`,
    operationType: "MANAGEMENT_RELEASE",
    businessPayloadFingerprint: `release-fingerprint-${legId}`,
    arbitrageId: "arbitrage-1",
    legId,
    releasedQuantity,
    reason: "USER_CONFIRMED_STOP_MANAGEMENT",
    source: "AUTHENTICATED_API",
    requestedByUserId: "user-a",
    requestedAt: at,
    confirmedAt: at + 2,
    venue: leg.venue,
    accountId: leg.accountId,
    instrumentId: leg.instrumentId,
    positionMode: "ONE_WAY",
    actualQuantity: releasedQuantity,
    actualSignedNetQuantity: leg.role === "SHORT" ? `-${releasedQuantity}` : releasedQuantity,
    actualLongQuantity: leg.role === "LONG" ? releasedQuantity : "0",
    actualShortQuantity: leg.role === "SHORT" ? releasedQuantity : "0",
    availableQuantity: null,
    realityCheckedAt: at + 1,
  }).release;
}

function unknownPnl() {
  return {
    asset: null,
    cumulativeFundingPnl: null,
    realizedTradingPnl: null,
    feesCosts: null,
    cumulativeNetPnl: null,
    updatedAt: null,
  } as const;
}

function withStore(operation: (fixture: { store: ArbitrageInstanceStore; dbPath: string }) => void) {
  withDatabase(({ dbPath }) => {
    const store = new ArbitrageInstanceStore({ dbPath });
    try {
      operation({ store, dbPath });
    } finally {
      store.close();
    }
  });
}

function withDatabase(operation: (fixture: { dbPath: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), "arbitrage-instance-store-"));
  try {
    operation({ dbPath: join(root, "arbitrage-instances.sqlite") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withAsyncDatabase(operation: (fixture: { dbPath: string }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "arbitrage-instance-store-"));
  try {
    await operation({ dbPath: join(root, "arbitrage-instances.sqlite") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
