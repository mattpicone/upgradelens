-- UpgradeLens canonical schema (D1 / SQLite)

CREATE TABLE IF NOT EXISTS packages (
  id INTEGER PRIMARY KEY,
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  repository_url TEXT,
  deprecated INTEGER DEFAULT 0,
  latest_stable TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(ecosystem, name)
);

CREATE TABLE IF NOT EXISTS upgrade_pairs (
  id INTEGER PRIMARY KEY,
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  runtime_key TEXT NOT NULL DEFAULT '',
  analysis_version TEXT NOT NULL,
  decision TEXT NOT NULL,
  risk_score INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  fresh_at TEXT NOT NULL,
  UNIQUE(ecosystem, package, from_version, to_version, runtime_key, analysis_version)
);
CREATE INDEX IF NOT EXISTS idx_pairs_lookup ON upgrade_pairs(ecosystem, package, from_version, to_version);

CREATE TABLE IF NOT EXISTS release_evidence (
  id TEXT PRIMARY KEY,
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  version TEXT,
  source_type TEXT NOT NULL,      -- registry | osv | deps_dev | endoflife | github_release | changelog
  source_url TEXT NOT NULL,
  fact TEXT NOT NULL,             -- normalized short fact (never full copyrighted bodies)
  content_hash TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_pkg ON release_evidence(ecosystem, package, version);

-- Precomputed breaking-change facts (populated by GitHub Actions enrichment job)
CREATE TABLE IF NOT EXISTS breaking_changes (
  id INTEGER PRIMARY KEY,
  ecosystem TEXT NOT NULL,
  package TEXT NOT NULL,
  version TEXT NOT NULL,          -- version that introduced the change
  summary TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'unknown',
  source_url TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8,
  fetched_at TEXT NOT NULL,
  UNIQUE(ecosystem, package, version, summary)
);
CREATE INDEX IF NOT EXISTS idx_breaking_pkg ON breaking_changes(ecosystem, package);

CREATE TABLE IF NOT EXISTS source_snapshots (
  source TEXT PRIMARY KEY,        -- npm | pypi | osv | deps_dev | endoflife
  last_success_at TEXT,
  last_error_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS api_clients (
  id INTEGER PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  internal INTEGER NOT NULL DEFAULT 0,   -- 1 = owner/CI/test traffic, excluded from business metrics
  daily_quota INTEGER NOT NULL DEFAULT 500,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  external INTEGER NOT NULL,             -- 1 = external origin; not sufficient for business metrics
  client_key TEXT,                        -- key hash prefix or 'anon:<ip-hash>'
  surface TEXT NOT NULL,                  -- rest | mcp | dashboard | meta
  tool TEXT NOT NULL,                     -- endpoint path or MCP tool name
  ecosystem TEXT,
  package TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  unknown_result INTEGER NOT NULL DEFAULT 0,
  price_usd REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  user_agent TEXT,
  referrer TEXT,
  experiment TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_client ON usage_events(client_key, ts);

-- MCP transport and business-funnel telemetry is intentionally separate from
-- generic REST usage. Protocol discovery must never inflate business status.
CREATE TABLE IF NOT EXISTS mcp_events (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  external INTEGER NOT NULL,
  traffic_class TEXT NOT NULL,          -- internal | verification | external
  actor_class TEXT NOT NULL,            -- internal | registry_verifier | auth_verifier | crawler_monitor | external_tool_client | unknown
  verification_kind TEXT NOT NULL DEFAULT 'none',
  classification_reason TEXT NOT NULL,
  classification_version INTEGER NOT NULL,
  client_key TEXT NOT NULL,
  http_method TEXT NOT NULL,
  rpc_method TEXT,
  event_kind TEXT NOT NULL,             -- initialize | tools_list | tools_call | ...
  requested_tool TEXT,
  business_tool TEXT,
  known_tool INTEGER NOT NULL DEFAULT 0,
  tool_invoked INTEGER,
  tool_success INTEGER,
  rpc_error_code INTEGER,
  error_kind TEXT,
  protocol_version TEXT,
  owned_test INTEGER NOT NULL DEFAULT 0,
  ecosystem TEXT,
  package TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  unknown_result INTEGER NOT NULL DEFAULT 0,
  auth_state TEXT NOT NULL DEFAULT 'none',
  client_name TEXT,
  client_version TEXT,
  user_agent TEXT,
  referrer TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_events_ts ON mcp_events(ts);
CREATE INDEX IF NOT EXISTS idx_mcp_events_client ON mcp_events(client_key, ts);
CREATE INDEX IF NOT EXISTS idx_mcp_events_funnel ON mcp_events(classification_version, external, traffic_class, event_kind, known_tool, tool_invoked, tool_success, ts);

CREATE TABLE IF NOT EXISTS billing_ledger (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  client_key TEXT NOT NULL,
  request_id TEXT,
  entry_type TEXT NOT NULL,       -- debit | credit | fee
  amount_usd REAL NOT NULL,
  rail TEXT,                      -- x402 | credits | subscription
  settlement_id TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS experiments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  variant TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  metrics_json TEXT
);

-- Dashboard counters use an auditable baseline instead of deleting telemetry.
-- Migration 0005 inserts the production reset timestamp idempotently.
CREATE TABLE IF NOT EXISTS dashboard_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  counts_reset_at TEXT NOT NULL,
  reset_reason TEXT NOT NULL DEFAULT 'business-validation-baseline',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_counters (
  bucket TEXT PRIMARY KEY,        -- e.g. 'm:<minute>:<client>' / 'd:<day>:<client>'
  count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
