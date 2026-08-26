export const recoveryAuditSchema = `CREATE TABLE IF NOT EXISTS arbitrage_recovery_audit (
  recoveryId TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('AUTHENTICATED_API', 'SYSTEM_RECOVERY')),
  actorId TEXT NOT NULL,
  arbitrageId TEXT NOT NULL,
  legId TEXT NOT NULL,
  executionIntentId TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'LOCAL_NOT_DISPATCHED_TERMINALIZATION', 'HISTORICAL_RECONCILE',
    'LEGACY_HISTORICAL_REPAIR', 'SPOT_ATTRIBUTION_BACKFILL'
  )),
  oldStatus TEXT NOT NULL,
  oldQuantity TEXT NOT NULL,
  newStatus TEXT NOT NULL,
  newQuantity TEXT NOT NULL,
  evidenceCategory TEXT NOT NULL,
  checkedAt INTEGER NOT NULL,
  completedAt INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result = 'COMPLETED')
) STRICT;

CREATE INDEX IF NOT EXISTS arbitrage_recovery_audit_instance_completed
  ON arbitrage_recovery_audit(arbitrageId, completedAt DESC);`;
