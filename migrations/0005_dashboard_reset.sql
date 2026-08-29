-- Establish the dashboard's zero-count baseline without deleting telemetry.
-- Idempotent: repeated deployment runs preserve the first reset timestamp.
CREATE TABLE IF NOT EXISTS dashboard_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  counts_reset_at TEXT NOT NULL,
  reset_reason TEXT NOT NULL DEFAULT 'business-validation-baseline',
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO dashboard_state (id, counts_reset_at, reset_reason, updated_at)
VALUES (
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  'business-validation-baseline',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
