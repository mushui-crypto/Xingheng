import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  StageFiveReadinessError,
  capitalTestGateStatus,
  canonicalStageFiveDigest,
  requireGateOneExternalApproval,
  requireGateTwoExternalApproval,
  validateBackendOperationsPreparation,
  validateCombinedRevisionForGateOne,
  validateOfflineBackendCoverage,
  validatePostApprovalReleaseEvidence,
  validateRealWindowEvidence,
  validateZeroFundsReadiness,
} from "./stageFiveReadiness.ts";
import {
  RWA_AUTOMATION_BACKUP_AAD_SCHEMA,
  credentialEnvironment,
} from "../server/modules/arbitrage/automation/CredentialKeyProvider.ts";
import {
  RWA_AUTOMATION_BACKUP_DOMAIN,
} from "../server/modules/arbitrage/automation/RwaAutomationBackupService.ts";
import {
  assessResidual,
} from "../server/modules/arbitrage/automation/RwaNeutralHedgeExecutionEngine.ts";
import {
  RWA_ACTIVITY_MAX_PAGES_PER_SOURCE,
  RWA_PERPETUAL_ACTIVITY_SOURCES,
  RWA_SPOT_ACTIVITY_SOURCES,
} from "../server/modules/arbitrage/automation/RwaProviderActivityContinuity.ts";

const REVISION = "6".repeat(40);
const OTHER_REVISION = "7".repeat(40);
const API_IMAGE = `sha256:${"1".repeat(64)}`;
const WEB_IMAGE = `sha256:${"2".repeat(64)}`;
const STRATEGY_IMAGE = `sha256:${"3".repeat(64)}`;
const PROFILE_ID = "xaut:binance-xaut-spot-perp-v1";
const BINANCE_TRANSFER_TYPES = [
  "MAIN_UMFUTURE",
  "MAIN_CMFUTURE",
  "MAIN_MARGIN",
  "UMFUTURE_MAIN",
  "UMFUTURE_MARGIN",
  "CMFUTURE_MAIN",
  "CMFUTURE_MARGIN",
  "MARGIN_MAIN",
  "MARGIN_UMFUTURE",
  "MARGIN_CMFUTURE",
  "ISOLATEDMARGIN_MARGIN",
  "MARGIN_ISOLATEDMARGIN",
  "ISOLATEDMARGIN_ISOLATEDMARGIN",
  "MAIN_FUNDING",
  "FUNDING_MAIN",
  "FUNDING_UMFUTURE",
  "UMFUTURE_FUNDING",
  "MARGIN_FUNDING",
  "FUNDING_MARGIN",
  "FUNDING_CMFUTURE",
  "CMFUTURE_FUNDING",
];

test("backend preparation stays separate from overall stage-five acceptance", async () => {
  assert.deepEqual(validateBackendOperationsPreparation({
    backendRevision: REVISION,
    finalReleaseArtifactsBuilt: false,
    productionChanged: false,
    productionConnections: 0,
    providerMutations: 0,
    realMaterialsRead: 0,
  }), {
    scope: "backend_operations_preparation",
    revision: REVISION,
    overallStageFivePassed: false,
  });
});

test("capital-test risk acceptance unlocks preparation only", () => {
  const status = capitalTestGateStatus();
  assert.deepEqual(status, {
    p2FreshRwaRollbackReadiness: "INCOMPLETE",
    stsRestoreVerification: "BLOCKED",
    rollbackEvidence: "INCOMPLETE",
    riskAcceptance: "ACTIVE",
    capitalTestPreparation: "READY",
    capitalTestExecution: "BLOCKED_PENDING_AUTHORIZATION",
    providerAccess: "NOT_AUTHORIZED",
    realFunds: "NOT_AUTHORIZED",
  });
  assert.equal(Object.isFrozen(status), true);
});

test("offline backend coverage requires the full fake lifecycle and both venue fixtures", async () => {
  const evidence = offlineCoverage();
  assert.deepEqual(validateOfflineBackendCoverage(evidence), {
    backendOfflineCoverage: "complete",
  });
  await assertCategory(
    () => validateOfflineBackendCoverage({ ...evidence, bybitProtocolFixtures: false }),
    "stage_five_evidence_invalid",
  );
  await assertCategory(
    () => validateOfflineBackendCoverage({ ...evidence, providerMutations: 1 }),
    "stage_five_evidence_invalid",
  );
});

test("Gate 1 requires one clean combined revision before final artifacts exist", async () => {
  const evidence = gateOneRevision();
  assert.equal(
    validateCombinedRevisionForGateOne(evidence).nextStop,
    "gate_1_external_approval_required",
  );
  await assertCategory(
    () => validateCombinedRevisionForGateOne({ ...evidence, frontendMerged: false }),
    "frontend_not_merged",
  );
  await assertCategory(
    () => validateCombinedRevisionForGateOne({ ...evidence, frontendRevision: OTHER_REVISION }),
    "combined_revision_mismatch",
  );
  await assertCategory(
    () => validateCombinedRevisionForGateOne({ ...evidence, worktreeClean: false }),
    "stage_five_evidence_invalid",
  );
});

test("Gate 1 and Gate 2 remain no-argument external hard stops", async () => {
  assert.equal(requireGateOneExternalApproval.length, 0);
  assert.equal(requireGateTwoExternalApproval.length, 0);
  await assertCategory(requireGateOneExternalApproval, "gate_1_external_approval_required");
  await assertCategory(requireGateTwoExternalApproval, "gate_2_external_approval_required");
});

test("post-approval release evidence requires exact revision, digest and Compose mapping", async () => {
  const evidence = releaseEvidence();
  assert.equal(validatePostApprovalReleaseEvidence(evidence).revision, REVISION);
  assert.throws(
    () => validatePostApprovalReleaseEvidence({
      ...evidence,
      components: evidence.components.map((item) =>
        item.name === "web" ? { ...item, imageRevision: OTHER_REVISION } : item),
    }),
    /deployment revision mismatch/u,
  );
  assert.throws(
    () => validatePostApprovalReleaseEvidence({
      ...evidence,
      composeConfig: {
        ...evidence.composeConfig,
        services: {
          ...evidence.composeConfig.services,
          api: { ...evidence.composeConfig.services.api, image: WEB_IMAGE },
        },
      },
    }),
    /release mapping is invalid/u,
  );
});

test("zero-funds readiness is Binance XAUT read-only and stops before Gate 2", async () => {
  const evidence = zeroFunds();
  const result = validateZeroFundsReadiness(evidence);
  assert.equal(result.nextStop, "gate_2_external_approval_required");
  assert.equal(result.capitalTestGate, capitalTestGateStatus());
  await assertCategory(
    () => validateZeroFundsReadiness({ ...evidence, providerMutations: 1 }),
    "stage_five_evidence_invalid",
  );
  await assertCategory(
    () => validateZeroFundsReadiness({ ...evidence, venue: "bybit" }),
    "real_window_scope_invalid",
  );
  await assertCategory(
    () => validateZeroFundsReadiness({ ...evidence, authorizationCreated: true }),
    "stage_five_evidence_invalid",
  );
});

test("real-window evidence uses authoritative sizing, causal runtime facts and real artifacts", async () => {
  const fixture = realWindowFixture();
  try {
    const result = await validateRealWindowEvidence(fixture.evidence);
    assert.equal(result.realWindowEvidence, "verified");
    assert.equal(result.minimumQuantityBase, 0.002);
    assert.equal(result.privateSnapshotDigests.length, 3);
    assert.equal(result.spotResidual.tradable, false);
    assert.equal(result.scopeDigest, canonicalStageFiveDigest(fixture.evidence.scope));
  } finally {
    fixture.cleanup();
  }
});

test("scope, account, takeover, window and revision substitutions fail closed", async () => {
  for (const field of [
    "accountFingerprint",
    "authorizationId",
    "takeoverId",
    "windowId",
    "revision",
  ]) {
    const fixture = realWindowFixture();
    try {
      const replacement = field === "revision"
        ? OTHER_REVISION
        : field === "accountFingerprint"
          ? "f".repeat(16)
          : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const check = fixture.evidence.observation.checks[1];
      await assertCategory(
        () => validateRealWindowEvidence({
          ...fixture.evidence,
          observation: {
            checks: fixture.evidence.observation.checks.map((item) =>
              item === check
                ? { ...item, scope: { ...item.scope, [field]: replacement } }
                : item),
          },
        }),
        "scope_binding_invalid",
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("shared calculator derives live common minimum and rejects changed rules or depth", async () => {
  const fixture = realWindowFixture();
  try {
    const lowerPrice = (market) => ({
      ...market,
      spot: { ...market.spot, ask: 2_000 },
      perpetual: { ...market.perpetual, bid: 2_000 },
    });
    const lower = {
      ...fixture.evidence,
      minimumSizing: {
        ...fixture.evidence.minimumSizing,
        preview: lowerPrice(fixture.evidence.minimumSizing.preview),
        current: lowerPrice(fixture.evidence.minimumSizing.current),
      },
    };
    assert.equal((await validateRealWindowEvidence(lower)).minimumQuantityBase, 0.003);
    await assertCategory(
      () => validateRealWindowEvidence({
        ...fixture.evidence,
        minimumSizing: {
          ...fixture.evidence.minimumSizing,
          current: {
            ...fixture.evidence.minimumSizing.current,
            spot: {
              ...fixture.evidence.minimumSizing.current.spot,
              executableDepthBase: 0.001,
            },
          },
        },
      }),
      "minimum_quantity_invalid",
    );
    await assertCategory(
      () => validateRealWindowEvidence({
        ...fixture.evidence,
        minimumSizing: {
          ...fixture.evidence.minimumSizing,
          claimedQuantityBase: 0.002,
        },
      }),
      "stage_five_evidence_invalid",
    );
  } finally {
    fixture.cleanup();
  }
});

test("private checks bind capture and persistence and span ten minutes themselves", async () => {
  const concentrated = realWindowFixture({ checkOffsets: [1, 2, 3] });
  try {
    await assertCategory(
      () => validateRealWindowEvidence(concentrated.evidence),
      "observation_too_short",
    );
  } finally {
    concentrated.cleanup();
  }
  const duplicate = realWindowFixture({ checkOffsets: [60_000, 60_000, 660_000] });
  try {
    await assertCategory(
      () => validateRealWindowEvidence(duplicate.evidence),
      "private_checks_incomplete",
    );
  } finally {
    duplicate.cleanup();
  }
  const mismatch = realWindowFixture();
  try {
    const first = mismatch.evidence.observation.checks[0];
    await assertCategory(
      () => validateRealWindowEvidence({
        ...mismatch.evidence,
        observation: {
          checks: [
            {
              ...first,
              snapshot: { ...first.snapshot, capturedAt: first.checkedAt + 1 },
            },
            ...mismatch.evidence.observation.checks.slice(1),
          ],
        },
      }),
      "causal_timeline_invalid",
    );
  } finally {
    mismatch.cleanup();
  }
});

test("restart proves ordered recovery and exact provider order-set continuity", async () => {
  const fixture = realWindowFixture();
  try {
    const changed = fixture.evidence.restart.ordersAfter.orders.map((item, index) =>
      index === 0 ? { ...item, providerOrderId: "provider-replaced" } : item);
    await assertCategory(
      () => validateRealWindowEvidence({
        ...fixture.evidence,
        restart: {
          ...fixture.evidence.restart,
          ordersAfter: { ...fixture.evidence.restart.ordersAfter, orders: changed },
        },
      }),
      "restart_duplicate_order",
    );
    await assertCategory(
      () => validateRealWindowEvidence({
        ...fixture.evidence,
        restart: {
          ...fixture.evidence.restart,
          requestedAt: fixture.evidence.restart.ordersBefore.capturedAt - 1,
        },
      }),
      "restart_recovery_invalid",
    );
  } finally {
    fixture.cleanup();
  }
});

test("causal chain rejects accepted-before-sizing, exit-before-observation, and gate-before-exit", async () => {
  const acceptedEarly = realWindowFixture();
  try {
    const first = acceptedEarly.evidence.mutationJournal[0];
    await assertCategory(
      () => validateRealWindowEvidence({
        ...acceptedEarly.evidence,
        mutationJournal: [
          {
            ...first,
            requestedAt: acceptedEarly.evidence.minimumSizing.current.capturedAt,
            acceptedAt: acceptedEarly.evidence.minimumSizing.current.capturedAt,
          },
          ...acceptedEarly.evidence.mutationJournal.slice(1),
        ],
      }),
      "causal_timeline_invalid",
    );
  } finally {
    acceptedEarly.cleanup();
  }

  const exitEarly = realWindowFixture();
  try {
    await assertCategory(
      () => validateRealWindowEvidence({
        ...exitEarly.evidence,
        exit: {
          ...exitEarly.evidence.exit,
          startedAt: exitEarly.evidence.observation.checks.at(-1).persistedAt,
        },
      }),
      "causal_timeline_invalid",
    );
  } finally {
    exitEarly.cleanup();
  }

  const gateEarly = realWindowFixture();
  try {
    await assertCategory(
      () => validateRealWindowEvidence({
        ...gateEarly.evidence,
        gateState: {
          ...gateEarly.evidence.gateState,
          capturedAt: gateEarly.evidence.exit.completedAt,
        },
      }),
      "causal_timeline_invalid",
    );
  } finally {
    gateEarly.cleanup();
  }
});

test("audit event times and exact set must match structured runtime sources bidirectionally", async () => {
  const early = realWindowFixture();
  try {
    rewriteAudit(early, (audit) => ({
      ...audit,
      entries: audit.entries.map((entry, index) => ({
        ...entry,
        occurredAt: early.evidence.windowOpenedAt + index + 1,
      })),
    }));
    await assertCategory(() => validateRealWindowEvidence(early.evidence), "artifact_evidence_invalid");
  } finally {
    early.cleanup();
  }

  for (const mutation of ["missing", "extra"]) {
    const fixture = realWindowFixture();
    try {
      rewriteAudit(fixture, (audit) => ({
        ...audit,
        entries: mutation === "missing"
          ? audit.entries.slice(0, -1)
          : [
              ...audit.entries,
              {
                ...audit.entries.at(-1),
                eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
                sequence: audit.entries.length + 1,
              },
            ],
      }));
      await assertCategory(() => validateRealWindowEvidence(fixture.evidence), "artifact_evidence_invalid");
    } finally {
      fixture.cleanup();
    }
  }
});

test("complete provider activity and mutation journal must be a one-to-one same-scope set", async () => {
  const missingSource = realWindowFixture();
  try {
    await assertCategory(
      () => validateRealWindowEvidence({
        ...missingSource.evidence,
        exit: {
          ...missingSource.evidence.exit,
          activity: {
            ...missingSource.evidence.exit.activity,
            sources: missingSource.evidence.exit.activity.sources.slice(1),
          },
        },
      }),
      "provider_activity_incomplete",
    );
  } finally {
    missingSource.cleanup();
  }

  const externalOrder = realWindowFixture();
  try {
    rewriteProviderResponse(externalOrder, "spot_trades", (response) => [
      ...response,
      {
        id: "manual-fill",
        isBuyer: false,
        orderId: "manual-order",
        qty: "0.0019",
        side: "SELL",
        symbol: "XAUTUSDT",
        time: externalOrder.evidence.exit.snapshot.capturedAt - 1,
      },
    ]);
    await assertCategory(
      () => validateRealWindowEvidence(externalOrder.evidence),
      "provider_activity_incomplete",
    );
  } finally {
    externalOrder.cleanup();
  }

  const missingJournal = realWindowFixture();
  try {
    await assertCategory(
      () => validateRealWindowEvidence({
        ...missingJournal.evidence,
        mutationJournal: missingJournal.evidence.mutationJournal.slice(1).map((entry, index) => ({
          ...entry,
          sequence: index + 1,
        })),
      }),
      "provider_activity_mismatch",
    );
  } finally {
    missingJournal.cleanup();
  }

  const extraJournal = realWindowFixture();
  try {
    const previous = extraJournal.evidence.mutationJournal.at(-1);
    await assertCategory(
      () => validateRealWindowEvidence({
        ...extraJournal.evidence,
        mutationJournal: [
          ...extraJournal.evidence.mutationJournal,
          {
            ...previous,
            acceptedAt: previous.persistedAt,
            clientOrderId: "unmatched-cancel",
            completedAt: previous.persistedAt,
            eventType: "cancel",
            journalId: "59999999-5555-4555-8555-999999999999",
            operation: "cancel_active_order",
            persistedAt: previous.persistedAt + 1,
            providerEventId: "unmatched-provider-event",
            providerOrderId: "unmatched-provider-order",
            actualFillQuantityBase: 0,
            requestedAt: previous.persistedAt,
            sequence: previous.sequence + 1,
          },
        ],
      }),
      "provider_activity_mismatch",
    );
  } finally {
    extraJournal.cleanup();
  }

  const crossScopeJournal = realWindowFixture();
  try {
    await assertCategory(
      () => validateRealWindowEvidence({
        ...crossScopeJournal.evidence,
        mutationJournal: crossScopeJournal.evidence.mutationJournal.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                scope: {
                  ...entry.scope,
                  takeoverId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                },
              }
            : entry),
      }),
      "scope_binding_invalid",
    );
  } finally {
    crossScopeJournal.cleanup();
  }

});

test("provider activity source, request, pagination and artifacts are exact", async () => {
  for (const mutate of [
    (fixture) => {
      fixture.evidence.exit.activity.sources[0].source = "dust";
    },
    (fixture) => {
      firstActivityRequest(fixture, "spot_orders").endpoint = "/api/v3/openOrders";
    },
    (fixture) => {
      firstActivityRequest(fixture, "spot_orders").httpMethod = "POST";
    },
    (fixture) => {
      firstActivityRequest(fixture, "spot_orders").params.startTime = "1";
    },
    (fixture) => {
      firstActivityRequest(fixture, "spot_orders").pageLimit = 1;
    },
    (fixture) => {
      firstActivityRequest(fixture, "spot_orders").watermarkOut -= 1;
    },
    (fixture) => {
      firstActivityRequest(fixture, "spot_orders").cursorOut = "unread-next-page";
      firstActivityRequest(fixture, "spot_orders").termination = "complete";
    },
    (fixture) => {
      firstActivityRequest(fixture, "spot_orders").streamId = "0".repeat(64);
    },
    (fixture) => {
      const source = fixture.evidence.exit.activity.sources
        .find((entry) => entry.source === "spot_orders");
      source.requests.push(structuredClone(source.requests[0]));
    },
    (fixture) => {
      const source = fixture.evidence.exit.activity.sources
        .find((entry) => entry.source === "spot_orders");
      source.requests = Array.from(
        { length: RWA_ACTIVITY_MAX_PAGES_PER_SOURCE + 1 },
        () => structuredClone(source.requests[0]),
      );
    },
  ]) {
    const fixture = realWindowFixture();
    try {
      mutate(fixture);
      await assertCategory(
        () => validateRealWindowEvidence(fixture.evidence),
        "provider_activity_incomplete",
      );
    } finally {
      fixture.cleanup();
    }
  }

  const artifactMismatch = realWindowFixture();
  try {
    const request = firstActivityRequest(artifactMismatch, "spot_orders");
    writeImmutable(request.responseArtifact.path, JSON.stringify([]), 0o400);
    await assertCategory(
      () => validateRealWindowEvidence(artifactMismatch.evidence),
      "artifact_evidence_invalid",
    );
  } finally {
    artifactMismatch.cleanup();
  }

  const parserMismatch = realWindowFixture();
  try {
    rewriteProviderResponse(parserMismatch, "spot_orders", () => ({ rows: [] }));
    await assertCategory(
      () => validateRealWindowEvidence(parserMismatch.evidence),
      "provider_activity_incomplete",
    );
  } finally {
    parserMismatch.cleanup();
  }

  const sourceOrder = realWindowFixture();
  try {
    sourceOrder.evidence.exit.activity.sources.reverse();
    await assertCategory(
      () => validateRealWindowEvidence(sourceOrder.evidence),
      "provider_activity_incomplete",
    );
  } finally {
    sourceOrder.cleanup();
  }

  const crossPartition = realWindowFixture();
  try {
    replaceProviderResponseArtifact(crossPartition, "deposits", [{
      coin: "XAUT",
      id: "internal-as-external",
      insertTime: crossPartition.evidence.exit.snapshot.capturedAt - 2,
      transferType: 1,
    }], "cross-deposits");
    replaceProviderResponseArtifact(crossPartition, "internal_deposits", [{
      coin: "XAUT",
      id: "external-as-internal",
      insertTime: crossPartition.evidence.exit.snapshot.capturedAt - 1,
      transferType: 0,
    }], "cross-internal-deposits");
    await assertCategory(
      () => validateRealWindowEvidence(crossPartition.evidence),
      "provider_activity_incomplete",
    );
  } finally {
    crossPartition.cleanup();
  }
});

test("non-order XAUT activity from every frozen family fails closed", async () => {
  const cases = [
    ["internal_transfers", { asset: "XAUT", status: "CONFIRMED", timestamp: 1_800_000_688_999, tranId: "manual-internal" }],
    ["universal_transfers", { asset: "XAUT", status: "CONFIRMED", timestamp: 1_800_000_688_999, tranId: "manual-universal" }],
    ["deposits", { coin: "XAUT", id: "manual-deposit", insertTime: 1_800_000_688_999, transferType: 0 }],
    ["internal_deposits", { coin: "XAUT", id: "manual-internal-deposit", insertTime: 1_800_000_688_999, transferType: 1 }],
    ["withdrawals", { applyTime: new Date(1_800_000_688_999).toISOString(), coin: "XAUT", id: "manual-withdrawal" }],
    ["convert", { fromAsset: "XAUT", orderId: "manual-convert", orderStatus: "SUCCESS", quoteId: "manual-quote", createTime: 1_800_000_688_999, toAsset: "USDT" }],
    ["dust", {
      operateTime: 1_800_000_688_999,
      transId: "manual-dust",
      userAssetDribbletDetails: [{ fromAsset: "XAUT" }],
    }],
    ["balance_adjustments", { amount: "0.001", asset: "XAUT", divTime: 1_800_000_688_999, id: "manual-adjustment" }],
  ];
  for (const [source, row] of cases) {
    const fixture = realWindowFixture();
    try {
      rewriteProviderResponse(fixture, source, () =>
        source === "convert"
          ? { list: [row] }
          : source === "dust"
            ? { userAssetDribblets: [row] }
            : ["internal_transfers", "universal_transfers", "balance_adjustments"].includes(source)
              ? { rows: [row], total: 1 }
              : [row]);
      await assertCategory(
        () => validateRealWindowEvidence(fixture.evidence),
        "provider_activity_incomplete",
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("partial fills aggregate per order and reject overflow, duplicate and cross-order fills", async () => {
  const valid = realWindowFixture({
    mutationJournalFactory: (scope, openedAt) =>
      createMutationJournal(scope, openedAt, {
        perpetualAccepted: 0.01,
        perpetualFills: [0.002, 0.004],
        spotAccepted: 0.005,
        spotFill: 0.005,
      }),
  });
  try {
    assert.equal((await validateRealWindowEvidence(valid.evidence)).realWindowEvidence, "verified");
  } finally {
    valid.cleanup();
  }

  for (const mutate of [
    (journal) => {
      journal.find((entry) => entry.providerEventId === "perpetual_trades:perp-fill-2")
        .actualFillQuantityBase = 0.009;
    },
    (journal) => {
      journal.find((entry) => entry.providerEventId === "perpetual_trades:perp-fill-2")
        .providerEventId = "perpetual_trades:perp-fill-1";
    },
    (journal) => {
      journal.find((entry) => entry.providerEventId === "perpetual_trades:perp-fill-2")
        .providerOrderId = "wrong-order";
    },
  ]) {
    const fixture = realWindowFixture();
    try {
      mutate(fixture.evidence.mutationJournal);
      await assertCategory(
        () => validateRealWindowEvidence(fixture.evidence),
        "mutation_journal_invalid",
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test("exit dust is independently recomputed and perpetual residual must be exactly zero", async () => {
  const tradable = realWindowFixture();
  try {
    await assertCategory(
      () => validateRealWindowEvidence({
        ...tradable.evidence,
        exit: {
          ...tradable.evidence.exit,
          snapshot: {
            ...tradable.evidence.exit.snapshot,
            spotAvailableQuantityBase: 0.002,
          },
        },
      }),
      "tradable_spot_residual_present",
    );
    await assertCategory(
      () => validateRealWindowEvidence({
        ...tradable.evidence,
        exit: {
          ...tradable.evidence.exit,
          snapshot: {
            ...tradable.evidence.exit.snapshot,
            perpetualShortQuantityBase: 0.001,
          },
        },
      }),
      "perpetual_residual_present",
    );
    await assertCategory(
      () => validateRealWindowEvidence({
        ...tradable.evidence,
        exit: {
          ...tradable.evidence.exit,
          humanSpotSaleCount: 0,
        },
      }),
      "stage_five_evidence_invalid",
    );
  } finally {
    tradable.cleanup();
  }
});

test("SQLite and RWA backups require real formats, exact envelopes and revision sidecars", async () => {
  const textSqlite = realWindowFixture({ textSqlite: true });
  try {
    await assertCategory(() => validateRealWindowEvidence(textSqlite.evidence), "sqlite_backup_invalid");
  } finally {
    textSqlite.cleanup();
  }

  const textRwa = realWindowFixture({ textRwa: true });
  try {
    await assertCategory(() => validateRealWindowEvidence(textRwa.evidence), "rwa_backup_invalid");
  } finally {
    textRwa.cleanup();
  }

  const extraRwa = realWindowFixture({ extraRwaKey: true });
  try {
    await assertCategory(() => validateRealWindowEvidence(extraRwa.evidence), "rwa_backup_invalid");
  } finally {
    extraRwa.cleanup();
  }

  const badSidecar = realWindowFixture();
  try {
    const path = badSidecar.evidence.artifacts.sqliteBackup.attestation.path;
    const sidecar = JSON.parse(readFileSync(path, "utf8"));
    writeImmutable(path, JSON.stringify({ ...sidecar, revision: OTHER_REVISION }), 0o400);
    badSidecar.evidence.artifacts.sqliteBackup.attestation = artifactEvidence(path);
    await assertCategory(
      () => validateRealWindowEvidence(badSidecar.evidence),
      "artifact_revision_mismatch",
    );
  } finally {
    badSidecar.cleanup();
  }
});

test("immutable artifact boundaries reject symlinks, hardlinks and extra metadata", async () => {
  const symlink = realWindowFixture();
  try {
    const link = join(symlink.directory, "sqlite-link");
    symlinkSync(symlink.evidence.artifacts.sqliteBackup.artifact.path, link);
    symlink.evidence.artifacts.sqliteBackup.artifact = {
      ...symlink.evidence.artifacts.sqliteBackup.artifact,
      path: link,
    };
    await assertCategory(() => validateRealWindowEvidence(symlink.evidence), "artifact_evidence_invalid");
  } finally {
    symlink.cleanup();
  }

  const hardlink = realWindowFixture();
  try {
    linkSync(
      hardlink.evidence.artifacts.rwaEncryptedBackup.artifact.path,
      join(hardlink.directory, "rwa-hardlink"),
    );
    await assertCategory(() => validateRealWindowEvidence(hardlink.evidence), "artifact_evidence_invalid");
  } finally {
    hardlink.cleanup();
  }

  const extra = realWindowFixture();
  try {
    extra.evidence.artifacts.releaseManifest.artifact = {
      ...extra.evidence.artifacts.releaseManifest.artifact,
      revision: REVISION,
    };
    await assertCategory(() => validateRealWindowEvidence(extra.evidence), "stage_five_evidence_invalid");
  } finally {
    extra.cleanup();
  }
});

function gateOneRevision() {
  return {
    backendRevision: REVISION,
    developRevision: REVISION,
    finalReleaseArtifactsBuilt: false,
    frontendMerged: true,
    frontendRevision: REVISION,
    mainRevision: REVISION,
    productionConnected: false,
    worktreeClean: true,
  };
}

function offlineCoverage() {
  return {
    accountAuthorization: true,
    backupRestore: true,
    binanceProtocolFixtures: true,
    bybitProtocolFixtures: true,
    crashRecoveryEveryMutationPoint: true,
    externalDerisk: true,
    fakeProvidersOnly: true,
    fundingExit: true,
    monitor: true,
    otherAssetWrites: 0,
    providerMutations: 0,
    reconfirm: true,
    takeover: true,
    userExit: true,
  };
}

function releaseManifest(revision = REVISION) {
  return {
    schemaVersion: 1,
    revision,
    images: {
      api: API_IMAGE,
      web: WEB_IMAGE,
      strategyTools: STRATEGY_IMAGE,
    },
  };
}

function releaseEvidence() {
  const componentDigest = {
    api: API_IMAGE,
    web: WEB_IMAGE,
    "strategy-tools": STRATEGY_IMAGE,
    "rwa-automation-backup": API_IMAGE,
    "rwa-automation-restore": API_IMAGE,
    "rwa-automation-verify": API_IMAGE,
  };
  const manifest = releaseManifest();
  const service = (image) => ({
    image,
    pull_policy: "never",
    environment: {
      XINGHENG_EXPECTED_REVISION: REVISION,
      XINGHENG_DEPLOYMENT_ENVIRONMENT: "production",
      XINGHENG_COMPOSE_PROJECT: "xingheng",
    },
  });
  return {
    revision: REVISION,
    manifest,
    composeConfig: {
      name: "xingheng",
      services: {
        api: service(API_IMAGE),
        web: service(WEB_IMAGE),
        "strategy-history": service(STRATEGY_IMAGE),
        "sqlite-restore": service(API_IMAGE),
        "provider-identity-preflight": service(API_IMAGE),
        "rwa-automation-backup": service(API_IMAGE),
        "rwa-automation-restore": service(API_IMAGE),
        "rwa-automation-verify": service(API_IMAGE),
      },
    },
    components: Object.entries(componentDigest).map(([name, image]) => ({
      name,
      imageRevision: REVISION,
      builtRevision: REVISION,
      runtimeRevision: REVISION,
      manifestDigest: image,
      actualDigest: image,
    })),
  };
}

function zeroFunds() {
  return {
    accountFingerprintMatched: true,
    accountModeComplete: true,
    accountPermissionsComplete: true,
    activeOrdersComplete: true,
    asset: "XAUT",
    authorizationCreated: false,
    authorizationPreviewGenerated: true,
    feesComplete: true,
    fundingComplete: true,
    instrumentRulesComplete: true,
    liquidationDataComplete: true,
    monitorReadOnlyGenerated: true,
    oneWayIsolatedSupported: true,
    privateDataFresh: true,
    providerMutations: 0,
    runtimeSwitches: {
      allUserKillSwitchesEnabled: true,
      executionEnabled: false,
      globalEnabled: false,
      serverKillSwitchEnabled: true,
      strategyEnabled: false,
    },
    serverAccountMatched: true,
    spotBalanceComplete: true,
    takeoverCalculationGenerated: true,
    takeoverCreated: false,
    venue: "binance",
    withdrawalDisabled: true,
  };
}

function realWindowFixture(options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "xingheng-stage-five-"));
  const openedAt = 1_800_000_000_000;
  const closedAt = openedAt + 12 * 60 * 1000;
  const scope = {
    accountFingerprint: "b".repeat(16),
    asset: "XAUT",
    authorizationId: "11111111-1111-4111-8111-111111111111",
    profileId: PROFILE_ID,
    revision: REVISION,
    takeoverId: "22222222-2222-4222-8222-222222222222",
    userDomain: "a".repeat(16),
    venue: "binance",
    windowId: "33333333-3333-4333-8333-333333333333",
  };
  const instrument = (market) => ({
    executableDepthBase: 0.1,
    minNotionalUsd: 5,
    minOrderQty: market === "spot" ? 0.0001 : 0.001,
    priceTick: 0.01,
    qtyStep: market === "spot" ? 0.0001 : 0.001,
    status: "Trading",
    symbol: "XAUTUSDT",
    [market === "spot" ? "ask" : "bid"]: market === "spot" ? 4_130 : 4_128,
  });
  const market = (capturedAt) => ({
    capturedAt,
    perpetual: instrument("perpetual"),
    scope,
    spot: instrument("spot"),
  });
  const orders = [
    order(scope, "spot", "stage5-existing-spot", "provider-spot"),
    order(scope, "perpetual", "stage5-existing-perpetual", "provider-perpetual"),
  ];
  const checkOffsets = options.checkOffsets ?? [60_000, 360_000, 660_000];
  const observation = {
    checks: checkOffsets.map((offset, index) => {
      const checkedAt = openedAt + offset;
      return {
        checkId: `private-${index + 1}`,
        checkedAt,
        persistedAt: checkedAt + 1_000,
        scope,
        snapshot: {
          accountFingerprint: scope.accountFingerprint,
          capturedAt: checkedAt,
          hedgeState: "strict",
          openOrders: [],
          perpetualShortQuantityBase: 0.002,
          spotQuantityBase: 0.002,
          takeoverState: "managed",
        },
      };
    }),
  };
  const restart = {
    apiRestartedAt: openedAt + 421_000,
    completedAt: openedAt + 422_000,
    ordersAfter: {
      capturedAt: openedAt + 423_000,
      orders: orders.map((item) => ({ ...item })),
      scope,
    },
    ordersBefore: {
      capturedAt: openedAt + 400_000,
      orders: orders.map((item) => ({ ...item })),
      scope,
    },
    persistedAt: openedAt + 424_000,
    requestedAt: openedAt + 420_000,
    scope,
    takeoverStateAfter: "managed",
    takeoverStateBefore: "managed",
  };
  const mutationJournal = options.mutationJournalFactory
    ? options.mutationJournalFactory(scope, openedAt)
    : createMutationJournal(scope, openedAt);
  const exitSnapshot = {
    accountFingerprint: scope.accountFingerprint,
    activeOrders: [],
    capturedAt: openedAt + 689_000,
    perpetual: exitInstrument("perpetual"),
    perpetualShortQuantityBase: 0,
    scope,
    spot: exitInstrument("spot"),
    spotAvailableQuantityBase: 0.0001,
  };
  const activity = writeProviderActivityEvidence(
    directory,
    scope,
    openedAt,
    exitSnapshot.capturedAt,
    mutationJournal,
  );
  const exit = {
    activity,
    completedAt: openedAt + 690_000,
    persistedAt: openedAt + 691_000,
    scope,
    snapshot: exitSnapshot,
    startedAt: openedAt + 670_000,
  };
  const gateState = {
    allUserKillSwitchesEnabled: true,
    capturedAt: openedAt + 700_000,
    closedAt,
    executionEnabled: false,
    globalEnabled: false,
    persistedAt: closedAt,
    scope,
    serverKillSwitchEnabled: true,
    strategyEnabled: false,
  };

  const release = writeArtifact(
    directory,
    "release.json",
    JSON.stringify(releaseManifest()),
    0o444,
  );
  const rollback = writeArtifact(
    directory,
    "rollback.json",
    JSON.stringify(releaseManifest(OTHER_REVISION)),
    0o444,
  );
  const sqliteArtifact = options.textSqlite
    ? writeArtifact(directory, "trading-20260726T010203Z.sqlite", "not sqlite", 0o400)
    : writeSqliteArtifact(directory);
  const rwaArtifact = writeRwaArtifact(directory, options);
  const sqlite = attestedArtifact(
    directory,
    sqliteArtifact,
    "sqlite_backup",
    REVISION,
    openedAt + 2_000,
  );
  const rwa = attestedArtifact(
    directory,
    rwaArtifact,
    "rwa_encrypted_backup",
    REVISION,
    openedAt + 3_000,
  );
  const releaseEvidence = { artifact: release, verifiedAt: openedAt + 1_000 };
  const rollbackEvidence = { artifact: rollback, verifiedAt: openedAt + 4_000 };
  const restartDigest = canonicalStageFiveDigest(
    [...orders].sort((left, right) =>
      canonicalString(left).localeCompare(canonicalString(right))),
  );
  const spotResidual = assessResidual(
    exitSnapshot.spotAvailableQuantityBase,
    exitSnapshot.spot.bid,
    exitSnapshot.spot.qtyStep,
    exitSnapshot.spot.minOrderQty,
    exitSnapshot.spot.minNotionalUsd,
  );
  const expected = [
    expectedAudit("release_manifest_verified", release.sha256, releaseEvidence.verifiedAt, {
      artifactSha256: release.sha256,
      artifactSizeBytes: release.sizeBytes,
      revision: REVISION,
    }),
    expectedAudit("sqlite_backup_verified", sqliteArtifact.sha256, sqlite.verifiedAt, {
      artifactSha256: sqliteArtifact.sha256,
      artifactSizeBytes: sqliteArtifact.sizeBytes,
      revision: REVISION,
    }),
    expectedAudit("rwa_backup_verified", rwaArtifact.sha256, rwa.verifiedAt, {
      artifactSha256: rwaArtifact.sha256,
      artifactSizeBytes: rwaArtifact.sizeBytes,
      revision: REVISION,
    }),
    expectedAudit("rollback_verified", rollback.sha256, rollbackEvidence.verifiedAt, {
      artifactSha256: rollback.sha256,
      artifactSizeBytes: rollback.sizeBytes,
      revision: OTHER_REVISION,
    }),
    ...mutationJournal.map((entry) => expectedAudit(
      entry.eventType,
      entry.journalId,
      entry.eventType === "accepted" ? entry.acceptedAt : entry.completedAt,
      mutationAuditSubject(entry),
    )),
    expectedAudit("restart", `restart:${scope.windowId}`, restart.persistedAt, {
      apiRestartedAt: restart.apiRestartedAt,
      completedAt: restart.completedAt,
      ordersAfterCapturedAt: restart.ordersAfter.capturedAt,
      ordersBeforeCapturedAt: restart.ordersBefore.capturedAt,
      ordersDigest: restartDigest,
      persistedAt: restart.persistedAt,
      requestedAt: restart.requestedAt,
      takeoverStateAfter: restart.takeoverStateAfter,
      takeoverStateBefore: restart.takeoverStateBefore,
    }),
    expectedAudit("exit_complete", `exit:${scope.takeoverId}`, exit.persistedAt, {
      activityDigest: canonicalStageFiveDigest(exit.activity),
      completedAt: exit.completedAt,
      persistedAt: exit.persistedAt,
      snapshotCapturedAt: exit.snapshot.capturedAt,
      snapshotDigest: canonicalStageFiveDigest(exit.snapshot),
      spotResidual,
      startedAt: exit.startedAt,
    }),
    expectedAudit("gate_closed", `gate:${scope.windowId}`, gateState.persistedAt, {
      allUserKillSwitchesEnabled: true,
      capturedAt: gateState.capturedAt,
      closedAt: gateState.closedAt,
      executionEnabled: false,
      globalEnabled: false,
      persistedAt: gateState.persistedAt,
      serverKillSwitchEnabled: true,
      strategyEnabled: false,
    }),
  ].sort((left, right) => left.occurredAt - right.occurredAt);
  const audit = {
    entries: expected.map((entry, index) => ({
      ...entry,
      eventId: `40000000-4444-4444-8444-${String(index).padStart(12, "0")}`,
      scope,
      sequence: index + 1,
    })),
    revision: REVISION,
    schemaVersion: 1,
    scope,
  };
  const auditArtifact = writeArtifact(
    directory,
    "stage-five-audit.json",
    JSON.stringify(audit),
    0o400,
  );

  return {
    directory,
    evidence: {
      artifacts: {
        auditLog: auditArtifact,
        releaseManifest: releaseEvidence,
        rollbackManifest: rollbackEvidence,
        rwaEncryptedBackup: rwa,
        sqliteBackup: sqlite,
      },
      exit,
      gateState,
      minimumSizing: {
        current: market(openedAt + 20_000),
        maxManagedCapitalUsd: 2_000,
        preview: market(openedAt + 10_000),
        totalManagedCapitalUsd: 8.3,
      },
      mutationJournal,
      observation,
      restart,
      scope,
      windowClosedAt: closedAt,
      windowOpenedAt: openedAt,
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function createMutationJournal(scope, openedAt, quantities = {}) {
  const perpetualAccepted = quantities.perpetualAccepted ?? 0.002;
  const perpetualFills = quantities.perpetualFills ?? [0.0008, 0.0012];
  const spotAccepted = quantities.spotAccepted ?? 0.0019;
  const spotFill = quantities.spotFill ?? 0.0019;
  const row = (
    sequence,
    eventType,
    operation,
    market,
    clientOrderId,
    providerOrderId,
    providerEventId,
    requestedQuantityBase,
    acceptedQuantityBase,
    actualFillQuantityBase,
    requestedOffset,
    acceptedOffset,
    completedOffset,
    persistedOffset,
  ) => ({
    acceptedQuantityBase,
    acceptedAt: openedAt + acceptedOffset,
    actualFillQuantityBase,
    clientOrderId,
    completedAt: openedAt + completedOffset,
    eventType,
    journalId: `50000000-5555-4555-8555-${String(sequence).padStart(12, "0")}`,
    market,
    operation,
    persistedAt: openedAt + persistedOffset,
    providerEventId,
    providerOrderId,
    requestedQuantityBase,
    requestedAt: openedAt + requestedOffset,
    scope,
    sequence,
    symbol: "XAUTUSDT",
  });
  return [
    row(1, "cancel", "cancel_active_order", "spot", "stage5-existing-spot", "provider-spot", "spot_orders:provider-spot", 0, 0, 0, 671_000, 672_000, 673_000, 674_000),
    row(2, "cancel", "cancel_active_order", "perpetual", "stage5-existing-perpetual", "provider-perpetual", "perpetual_orders:provider-perpetual", 0, 0, 0, 675_000, 676_000, 677_000, 678_000),
    row(3, "accepted", "perpetual_reduce", "perpetual", "stage5-exit-perp", "provider-exit-perp", "perpetual_orders:provider-exit-perp", perpetualAccepted, perpetualAccepted, 0, 679_000, 680_000, 680_000, 681_000),
    row(4, "fill", "perpetual_reduce", "perpetual", "stage5-exit-perp", "provider-exit-perp", "perpetual_trades:perp-fill-1", 0, 0, perpetualFills[0], 679_000, 680_000, 682_000, 683_000),
    row(5, "fill", "perpetual_reduce", "perpetual", "stage5-exit-perp", "provider-exit-perp", "perpetual_trades:perp-fill-2", 0, 0, perpetualFills[1], 679_000, 680_000, 684_000, 685_000),
    row(6, "accepted", "spot_sell", "spot", "stage5-exit-spot", "provider-exit-spot", "spot_orders:provider-exit-spot", spotAccepted, spotAccepted, 0, 685_100, 686_000, 686_000, 687_000),
    row(7, "fill", "spot_sell", "spot", "stage5-exit-spot", "provider-exit-spot", "spot_trades:spot-fill-1", 0, 0, spotFill, 685_100, 686_000, 688_000, 688_500),
  ];
}

function order(scope, market, clientOrderId, providerOrderId) {
  return { clientOrderId, market, providerOrderId, scope, symbol: "XAUTUSDT" };
}

function exitInstrument(market) {
  return {
    executableDepthBase: 0.1,
    minNotionalUsd: 5,
    minOrderQty: market === "spot" ? 0.0001 : 0.001,
    priceTick: 0.01,
    qtyStep: market === "spot" ? 0.0001 : 0.001,
    status: "Trading",
    symbol: "XAUTUSDT",
    [market === "spot" ? "bid" : "ask"]: market === "spot" ? 4_127 : 4_131,
  };
}

function expectedAudit(eventType, sourceId, occurredAt, subject) {
  return { eventType, occurredAt, sourceId, subject };
}

function mutationAuditSubject(entry) {
  const { scope: _scope, ...subject } = entry;
  return subject;
}

function writeProviderActivityEvidence(
  directory,
  scope,
  windowStart,
  windowEnd,
  mutationJournal,
) {
  const plan = binanceActivityRequestPlan();
  const collectedAt = windowEnd + 500;
  const sharedResponses = new Map();
  const requests = plan.map((entry, index) => {
    const params = {
      ...entry.params,
      startTime: String(windowStart),
      endTime: String(windowEnd),
      ...(entry.pageParam ? { [entry.pageParam]: "1" } : {}),
      ...(entry.offsetParam ? { [entry.offsetParam]: "0" } : {}),
    };
    const requestDigest = canonicalStageFiveDigest({
      apiScope: entry.apiScope,
      endpoint: entry.endpoint,
      httpMethod: "GET",
      params,
      scopeDigest: canonicalStageFiveDigest(scope),
      source: entry.source,
      windowEnd,
      windowStart,
    });
    const responseKey = canonicalString({
      apiScope: entry.apiScope,
      endpoint: entry.endpoint,
      params,
    });
    let capture = sharedResponses.get(responseKey);
    if (!capture) {
      const response = activityResponse(entry.source, mutationJournal);
      capture = {
        requestedAt: windowEnd - 900 + index * 10,
        responseArtifact: writeArtifact(
          directory,
          `provider-${String(index).padStart(2, "0")}-${entry.source}.json`,
          JSON.stringify(response),
          0o400,
        ),
        responseCapturedAt: windowEnd - 895 + index * 10,
      };
      sharedResponses.set(responseKey, capture);
    }
    const { requestedAt, responseArtifact, responseCapturedAt } = capture;
    const responseAttestation = writeArtifact(
      directory,
      `provider-${String(index).padStart(2, "0")}-${entry.source}.attestation.json`,
      JSON.stringify({
        artifactKind: "binance-xaut-readonly-response",
        artifactSha256: responseArtifact.sha256,
        artifactSizeBytes: responseArtifact.sizeBytes,
        kind: "stage-five-provider-response-attestation",
        requestDigest,
        revision: scope.revision,
        schemaVersion: 1,
        scopeDigest: canonicalStageFiveDigest(scope),
        source: entry.source,
        windowEnd,
        windowStart,
      }),
      0o400,
    );
    return {
      apiScope: entry.apiScope,
      cursorIn: null,
      cursorOut: null,
      endpoint: entry.endpoint,
      httpMethod: "GET",
      pageIndex: 0,
      pageLimit: RWA_ACTIVITY_MAX_PAGES_PER_SOURCE,
      params,
      requestDigest,
      requestedAt,
      responseArtifact,
      responseAttestation,
      responseCapturedAt,
      streamId: activityStreamDigest(entry.source, entry.apiScope, entry.endpoint, params),
      termination: "complete",
      watermarkIn: windowStart,
      watermarkOut: windowEnd,
    };
  });
  const requiredSources = [...new Set([
    ...RWA_SPOT_ACTIVITY_SOURCES,
    ...RWA_PERPETUAL_ACTIVITY_SOURCES,
  ])].sort();
  return {
    collector: {
      capturedAt: collectedAt,
      collectorId: "rwa-binance-activity-capture-v1",
      revision: scope.revision,
      schemaVersion: 1,
      windowEnd,
      windowStart,
    },
    scope,
    sources: requiredSources.map((source) => ({
      requests: requests.filter((request, index) => plan[index].source === source),
      source,
    })),
  };
}

function binanceActivityRequestPlan() {
  const request = (source, apiScope, endpoint, params, pagination = {}) => ({
    source,
    apiScope,
    endpoint,
    params,
    ...pagination,
  });
  return [
    request("spot_orders", "spot", "/api/v3/allOrders", { symbol: "XAUTUSDT", limit: "1000" }),
    request("spot_trades", "spot", "/api/v3/myTrades", { symbol: "XAUTUSDT", limit: "1000" }),
    request("perpetual_orders", "futures", "/fapi/v1/allOrders", { symbol: "XAUTUSDT", limit: "1000" }),
    request("perpetual_trades", "futures", "/fapi/v1/userTrades", { symbol: "XAUTUSDT", limit: "1000" }),
    request("account_transactions", "futures", "/fapi/v1/income", { symbol: "XAUTUSDT", limit: "1000" }),
    ...BINANCE_TRANSFER_TYPES.map((type, index) => request(
      index < 2 ? "internal_transfers" : "universal_transfers",
      "spot",
      "/sapi/v1/asset/transfer",
      {
        type,
        size: "100",
        ...(type === "ISOLATEDMARGIN_MARGIN" ? { fromSymbol: "XAUTUSDT" } : {}),
        ...(type === "MARGIN_ISOLATEDMARGIN" ? { toSymbol: "XAUTUSDT" } : {}),
        ...(type === "ISOLATEDMARGIN_ISOLATEDMARGIN"
          ? { fromSymbol: "XAUTUSDT", toSymbol: "XAUTUSDT" }
          : {}),
      },
      { pageParam: "current" },
    )),
    request("deposits", "spot", "/sapi/v1/capital/deposit/hisrec", { coin: "XAUT", limit: "1000" }, { offsetParam: "offset" }),
    request("internal_deposits", "spot", "/sapi/v1/capital/deposit/hisrec", { coin: "XAUT", limit: "1000" }, { offsetParam: "offset" }),
    request("withdrawals", "spot", "/sapi/v1/capital/withdraw/history", { coin: "XAUT", limit: "1000" }, { offsetParam: "offset" }),
    request("convert", "spot", "/sapi/v1/convert/tradeFlow", { limit: "100" }),
    request("dust", "spot", "/sapi/v1/asset/dribblet", {}),
    request("balance_adjustments", "spot", "/sapi/v1/asset/assetDividend", { asset: "XAUT", limit: "500" }, { offsetParam: "offset" }),
  ];
}

function activityResponse(source, journal) {
  if (source === "spot_orders") {
    return [
      activityOrder(journal[0], "CANCELED"),
      activityOrder(journal.find((entry) =>
        entry.eventType === "accepted" && entry.market === "spot"), "FILLED"),
    ];
  }
  if (source === "perpetual_orders") {
    return [
      activityOrder(journal[1], "CANCELED"),
      activityOrder(journal.find((entry) =>
        entry.eventType === "accepted" && entry.market === "perpetual"), "FILLED"),
    ];
  }
  if (source === "spot_trades" || source === "perpetual_trades") {
    const market = source === "spot_trades" ? "spot" : "perpetual";
    return journal
      .filter((entry) => entry.eventType === "fill" && entry.market === market)
      .map((entry) => ({
        id: entry.providerEventId.split(":").at(-1),
        isBuyer: false,
        orderId: entry.providerOrderId,
        qty: String(entry.actualFillQuantityBase),
        side: "BUY",
        symbol: "XAUTUSDT",
        time: entry.completedAt,
      }));
  }
  if (source === "internal_transfers" || source === "universal_transfers" || source === "balance_adjustments") {
    return { rows: [], total: 0 };
  }
  if (source === "convert") return { list: [] };
  if (source === "dust") return { userAssetDribblets: [] };
  return [];
}

function activityOrder(entry, status) {
  return {
    clientOrderId: entry.clientOrderId,
    orderId: entry.providerOrderId,
    origQty: String(status === "CANCELED" ? 0.002 : entry.acceptedQuantityBase),
    status,
    symbol: "XAUTUSDT",
    ...(status === "CANCELED"
      ? { updateTime: entry.completedAt }
      : { time: entry.acceptedAt, updateTime: entry.completedAt }),
  };
}

function activityStreamDigest(source, apiScope, endpoint, params) {
  const paginationKeys = endpoint.includes("allOrders")
    ? ["orderId"]
    : endpoint.includes("myTrades") || endpoint.includes("userTrades")
      ? ["fromId"]
      : endpoint === "/fapi/v1/income"
        ? ["tranId"]
        : endpoint === "/sapi/v1/asset/transfer"
          ? ["current"]
          : [
              "/sapi/v1/capital/deposit/hisrec",
              "/sapi/v1/capital/withdraw/history",
              "/sapi/v1/asset/assetDividend",
            ].includes(endpoint)
            ? ["offset"]
            : [];
  const baseParams = Object.fromEntries(Object.entries(params)
    .filter(([key]) => !["startTime", "endTime", ...paginationKeys].includes(key)));
  return canonicalStageFiveDigest({ apiScope, baseParams, endpoint, source });
}

function writeSqliteArtifact(directory) {
  const path = join(directory, "trading-20260726T010203Z.sqlite");
  const database = new DatabaseSync(path);
  database.exec("CREATE TABLE readiness (id INTEGER PRIMARY KEY, revision TEXT NOT NULL)");
  database.prepare("INSERT INTO readiness (revision) VALUES (?)").run(REVISION);
  database.close();
  chmodSync(path, 0o400);
  return artifactEvidence(path);
}

function writeRwaArtifact(directory, options) {
  const path = join(directory, "rwa-automation-20260726T010203Z.rwa.enc.json");
  if (options.textRwa) return writeArtifact(directory, "rwa-invalid.rwa.enc.json", "not json", 0o400);
  const envelope = {
    aadSchema: RWA_AUTOMATION_BACKUP_AAD_SCHEMA,
    algorithm: "AES-256-GCM",
    backupDomain: RWA_AUTOMATION_BACKUP_DOMAIN,
    backupId: "20260726T010203Z",
    ciphertext: Buffer.alloc(32, 4).toString("base64url"),
    createdAt: Date.parse("2026-07-26T01:02:03Z"),
    environment: credentialEnvironment(),
    keyName: "public-test-key",
    nonce: Buffer.alloc(12, 5).toString("base64url"),
    provider: "fake",
    purpose: "automation-backup",
    tag: Buffer.alloc(16, 6).toString("base64url"),
    version: 1,
    wrapBindingTag: Buffer.alloc(32, 7).toString("base64url"),
    wrapReference: "public-test-wrap-reference",
    wrappedDek: Buffer.alloc(32, 8).toString("base64url"),
    ...(options.extraRwaKey ? { verified: true } : {}),
  };
  return writeArtifact(directory, path.split("/").at(-1), JSON.stringify(envelope), 0o400);
}

function attestedArtifact(directory, artifact, artifactKind, revision, verifiedAt) {
  const validation = artifactKind === "sqlite_backup"
    ? {
        format: "sqlite3",
        integrityCheck: "ok",
      }
    : (() => {
        let envelope = {};
        try {
          envelope = JSON.parse(readFileSync(artifact.path, "utf8"));
        } catch {
          // The negative fixture still needs a well-formed attestation around invalid bytes.
        }
        return {
          backupId: envelope.backupId ?? "20260726T010203Z",
          createdAt: envelope.createdAt ?? Date.parse("2026-07-26T01:02:03Z"),
          environment: envelope.environment ?? credentialEnvironment(),
          purpose: "automation-backup",
          schemaVersion: 1,
        };
      })();
  const attestation = {
    artifactKind,
    artifactSha256: artifact.sha256,
    artifactSizeBytes: artifact.sizeBytes,
    kind: "stage-five-artifact-attestation",
    revision,
    schemaVersion: 1,
    validation,
  };
  const sidecar = writeArtifact(
    directory,
    `${artifactKind}.attestation.json`,
    JSON.stringify(attestation),
    0o400,
  );
  return { artifact, attestation: sidecar, verifiedAt };
}

function writeArtifact(directory, name, contents, mode) {
  const path = join(directory, name);
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, mode);
  return artifactEvidence(path);
}

function writeImmutable(path, contents, mode) {
  chmodSync(path, 0o600);
  writeFileSync(path, contents);
  chmodSync(path, mode);
}

function artifactEvidence(path) {
  const bytes = readFileSync(path);
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

function rewriteAudit(fixture, transform) {
  const path = fixture.evidence.artifacts.auditLog.path;
  const audit = transform(JSON.parse(readFileSync(path, "utf8")));
  writeImmutable(path, JSON.stringify(audit), 0o400);
  fixture.evidence.artifacts.auditLog = artifactEvidence(path);
}

function firstActivityRequest(fixture, source) {
  return fixture.evidence.exit.activity.sources
    .find((entry) => entry.source === source)
    .requests[0];
}

function rewriteProviderResponse(fixture, source, transform) {
  const request = firstActivityRequest(fixture, source);
  const response = transform(JSON.parse(readFileSync(request.responseArtifact.path, "utf8")));
  const artifactPath = request.responseArtifact.path;
  writeImmutable(artifactPath, JSON.stringify(response), 0o400);
  const artifact = artifactEvidence(artifactPath);
  const sharedRequests = fixture.evidence.exit.activity.sources
    .flatMap((entry) => entry.requests)
    .filter((entry) => entry.responseArtifact.path === artifactPath);
  for (const shared of sharedRequests) {
    shared.responseArtifact = artifact;
    const attestationPath = shared.responseAttestation.path;
    const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
    attestation.artifactSha256 = artifact.sha256;
    attestation.artifactSizeBytes = artifact.sizeBytes;
    writeImmutable(attestationPath, JSON.stringify(attestation), 0o400);
    shared.responseAttestation = artifactEvidence(attestationPath);
  }
}

function replaceProviderResponseArtifact(fixture, source, response, suffix) {
  const request = firstActivityRequest(fixture, source);
  request.responseArtifact = writeArtifact(
    fixture.directory,
    `${suffix}.json`,
    JSON.stringify(response),
    0o400,
  );
  const attestationPath = request.responseAttestation.path;
  const attestation = JSON.parse(readFileSync(attestationPath, "utf8"));
  attestation.artifactSha256 = request.responseArtifact.sha256;
  attestation.artifactSizeBytes = request.responseArtifact.sizeBytes;
  writeImmutable(attestationPath, JSON.stringify(attestation), 0o400);
  request.responseAttestation = artifactEvidence(attestationPath);
}

function canonicalString(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalString(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function assertCategory(run, category) {
  await assert.rejects(
    Promise.resolve().then(run),
    (error) => error instanceof StageFiveReadinessError && error.category === category,
  );
}
