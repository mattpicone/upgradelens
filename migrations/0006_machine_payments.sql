-- UpgradeLens v0.3 durable trial, execution, settlement and revenue state.
-- Additive and idempotent. Never changes dashboard_state.counts_reset_at.

CREATE TABLE IF NOT EXISTS business_calls (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  units INTEGER NOT NULL DEFAULT 1 CHECK (units > 0),
  canonical_request_hash TEXT NOT NULL,
  execution_state TEXT NOT NULL,       -- executing | result_saved | complete | failed
  result_json TEXT,
  delivery_state TEXT NOT NULL,        -- withheld | delivered
  access_type TEXT NOT NULL,           -- validation_free | trial | paid | owner
  business_eligible INTEGER NOT NULL DEFAULT 1 CHECK (business_eligible IN (0,1)),
  subject_hash TEXT NOT NULL,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_business_calls_attempts
  ON business_calls(access_type, delivery_state, created_at);
CREATE INDEX IF NOT EXISTS idx_business_calls_request_hash
  ON business_calls(canonical_request_hash);

CREATE TABLE IF NOT EXISTS trial_entitlements (
  subject_hash TEXT PRIMARY KEY,
  consumed_at TEXT,
  reserved_by TEXT,
  reserved_at TEXT,
  updated_at TEXT NOT NULL
);

-- Consuming a reservation and making its saved result deliverable must be one
-- SQLite transaction. OLD.reserved_by is the request id that owns the lease;
-- a stale loser cannot deliver after another request has reclaimed it.
CREATE TRIGGER IF NOT EXISTS trial_delivery_after_consume
AFTER UPDATE OF consumed_at ON trial_entitlements
WHEN NEW.consumed_at IS NOT NULL AND OLD.reserved_by IS NOT NULL
BEGIN
  UPDATE business_calls
  SET delivery_state='delivered', execution_state='complete',
      delivered_at=NEW.consumed_at, updated_at=NEW.updated_at
  WHERE id='trial:' || OLD.reserved_by AND delivery_state='withheld';
END;

CREATE TABLE IF NOT EXISTS payment_attempts (
  payment_identifier TEXT PRIMARY KEY,
  business_call_id TEXT NOT NULL UNIQUE,
  canonical_fingerprint TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  proof_hash TEXT NOT NULL,
  payer_hash TEXT,
  nonce_hash TEXT UNIQUE,
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_atomic TEXT NOT NULL,
  known_fee_micros INTEGER NOT NULL DEFAULT 0 CHECK (known_fee_micros >= 0),
  recipient TEXT NOT NULL,
  settlement_state TEXT NOT NULL,
  failure_code TEXT,
  receipt_json TEXT,
  transaction_hash TEXT,
  recovery_payload TEXT,
  eligible_mainnet INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  result_saved_at TEXT,
  settled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_attempts_reconcile
  ON payment_attempts(settlement_state, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_attempts_transaction
  ON payment_attempts(transaction_hash) WHERE transaction_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  payment_identifier TEXT,
  business_call_id TEXT,
  event_kind TEXT NOT NULL,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_payment_events_funnel ON payment_events(event_kind, ts);

CREATE TABLE IF NOT EXISTS billing_ledger_v3 (
  id INTEGER PRIMARY KEY,
  payment_identifier TEXT NOT NULL UNIQUE,
  transaction_hash TEXT NOT NULL UNIQUE,
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  fee_micros INTEGER NOT NULL DEFAULT 0 CHECK (fee_micros >= 0),
  network TEXT NOT NULL,
  asset TEXT NOT NULL,
  recipient TEXT NOT NULL,
  eligible_mainnet INTEGER NOT NULL DEFAULT 0,
  refunded_micros INTEGER NOT NULL DEFAULT 0 CHECK (refunded_micros >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rollout_attestations (
  id INTEGER PRIMARY KEY,
  git_sha TEXT NOT NULL,
  lockfile_hash TEXT NOT NULL,
  suite_hash TEXT NOT NULL,
  testnet_transaction TEXT NOT NULL,
  service_version TEXT NOT NULL,
  price_micros INTEGER NOT NULL,
  network TEXT NOT NULL,
  recipient_hash TEXT NOT NULL,
  passed_at TEXT NOT NULL,
  UNIQUE(git_sha, lockfile_hash, suite_hash, testnet_transaction)
);

CREATE TABLE IF NOT EXISTS discovery_status (
  channel TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  evidence_json TEXT,
  checked_at TEXT NOT NULL
);
