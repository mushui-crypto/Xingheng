import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FundingLegExecutionLinkStore } from "./FundingLegExecutionLinkStore";

const now = 1_800_000_000_000;

test("persists and queries execution intent and record identity for a funding leg", () => {
  withStores((first) => {
    assert.equal(first.findForUser("user-a", "funding-1", "leg-1"), null);
    assert.equal(first.claimForUser("user-a", "funding-1", "leg-1", "intent-1"), true);
    assert.equal(first.findForUser("user-a", "funding-1", "leg-1"), null);

    first.linkForUser("user-a", "funding-1", "leg-1", {
      executionIntentId: "intent-1",
      executionRecordId: "record-1",
    });

    assert.deepEqual(first.findForUser("user-a", "funding-1", "leg-1"), {
      executionIntentId: "intent-1",
      executionRecordId: "record-1",
    });
  });
});

test("database claim prevents duplicate execution while preserving user isolation", () => {
  withStores((first, second) => {
    assert.equal(first.claimForUser("user-a", "funding-1", "leg-1", "intent-a"), true);
    assert.equal(second.claimForUser("user-a", "funding-1", "leg-1", "intent-a-duplicate"), false);
    assert.equal(second.claimForUser("user-b", "funding-1", "leg-1", "intent-b"), true);

    first.linkForUser("user-a", "funding-1", "leg-1", {
      executionIntentId: "intent-a",
      executionRecordId: "record-a",
    });
    second.linkForUser("user-b", "funding-1", "leg-1", {
      executionIntentId: "intent-b",
      executionRecordId: "record-b",
    });

    assert.equal(first.findForUser("user-a", "funding-1", "leg-1")?.executionRecordId, "record-a");
    assert.equal(first.findForUser("user-b", "funding-1", "leg-1")?.executionRecordId, "record-b");
    assert.equal(first.findForUser("user-c", "funding-1", "leg-1"), null);
  });
});

function withStores(operation: (
  first: FundingLegExecutionLinkStore,
  second: FundingLegExecutionLinkStore,
) => void) {
  const root = mkdtempSync(join(tmpdir(), "funding-leg-links-"));
  const dbPath = join(root, "links.sqlite");
  const first = new FundingLegExecutionLinkStore({ dbPath, now: () => now });
  const second = new FundingLegExecutionLinkStore({ dbPath, now: () => now + 1 });
  try {
    operation(first, second);
  } finally {
    second.close();
    first.close();
    rmSync(root, { recursive: true, force: true });
  }
}
