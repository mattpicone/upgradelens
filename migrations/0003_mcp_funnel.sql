-- MCP-specific funnel telemetry. Idempotent so deployment automation may
-- safely reapply it. Legacy rows remain visible, but classification_version=0
-- and NULL invocation/success fields prevent unverifiable pre-cutover traffic
-- from ever becoming a confirmed business signal.

CREATE TABLE IF NOT EXISTS mcp_events (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  external INTEGER NOT NULL,
  traffic_class TEXT NOT NULL,
  actor_class TEXT NOT NULL,
  verification_kind TEXT NOT NULL DEFAULT 'none',
  classification_reason TEXT NOT NULL,
  classification_version INTEGER NOT NULL,
  client_key TEXT NOT NULL,
  http_method TEXT NOT NULL,
  rpc_method TEXT,
  event_kind TEXT NOT NULL,
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
CREATE INDEX IF NOT EXISTS idx_mcp_events_funnel
  ON mcp_events(classification_version, external, traffic_class, event_kind,
                known_tool, tool_invoked, tool_success, ts);

INSERT OR IGNORE INTO mcp_events
  (request_id, ts, external, traffic_class, actor_class, verification_kind,
   classification_reason, classification_version, client_key, http_method,
   rpc_method, event_kind, requested_tool, business_tool, known_tool,
   tool_invoked, tool_success, error_kind, owned_test, ecosystem, package,
   cache_hit, status, latency_ms, unknown_result, auth_state, user_agent, referrer)
SELECT
  request_id,
  ts,
  external,
  CASE
    WHEN external=0 THEN 'internal'
    WHEN client_key LIKE 'invalid:%' THEN 'verification'
    WHEN lower(COALESCE(tool,'')) LIKE 'mcp:__verifymcp_auth_probe_%'
      OR lower(COALESCE(user_agent,'')) LIKE '%verifymcp%' THEN 'verification'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%registry%'
      OR lower(COALESCE(user_agent,'')) LIKE '%audit%'
      OR lower(COALESCE(user_agent,'')) LIKE '%scan%'
      OR lower(COALESCE(user_agent,'')) LIKE '%security%'
      OR lower(COALESCE(user_agent,'')) LIKE '%sentinel%'
      OR lower(COALESCE(user_agent,'')) LIKE '%endpointaudit%'
      OR lower(COALESCE(user_agent,'')) LIKE '%mcpgrade%'
      OR lower(COALESCE(user_agent,'')) LIKE '%agentgrade%'
      OR lower(COALESCE(user_agent,'')) LIKE '%health%'
      OR lower(COALESCE(user_agent,'')) LIKE '%liveness%'
      OR lower(COALESCE(user_agent,'')) LIKE '%monitor%'
      OR lower(COALESCE(user_agent,'')) LIKE '%observatory%'
      OR lower(COALESCE(user_agent,'')) LIKE '%mcpbeat%'
      OR lower(COALESCE(user_agent,'')) LIKE '%stats-prober%'
      OR lower(COALESCE(user_agent,'')) GLOB '*[^a-z]bot[^a-z]*'
      OR lower(COALESCE(user_agent,'')) LIKE '%crawl%'
      OR lower(COALESCE(user_agent,'')) LIKE '%scrap%'
      OR lower(COALESCE(user_agent,'')) LIKE '%probe%'
      OR lower(COALESCE(user_agent,'')) LIKE '%census%'
      OR lower(COALESCE(user_agent,'')) LIKE '%witness%'
      OR lower(COALESCE(user_agent,'')) LIKE '%tripwire%'
      OR lower(COALESCE(user_agent,'')) LIKE '%research%'
      OR lower(COALESCE(user_agent,'')) LIKE '%reputation%'
      OR lower(COALESCE(user_agent,'')) LIKE '%measure-mcp%'
      THEN 'verification'
    ELSE 'external'
  END,
  CASE
    WHEN external=0 THEN 'internal'
    WHEN lower(COALESCE(tool,'')) LIKE 'mcp:__verifymcp_auth_probe_%'
      OR lower(COALESCE(user_agent,'')) LIKE '%verifymcp%'
      OR client_key LIKE 'invalid:%' THEN 'auth_verifier'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%registry%' THEN 'registry_verifier'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%audit%'
      OR lower(COALESCE(user_agent,'')) LIKE '%scan%'
      OR lower(COALESCE(user_agent,'')) LIKE '%security%'
      OR lower(COALESCE(user_agent,'')) LIKE '%sentinel%'
      OR lower(COALESCE(user_agent,'')) LIKE '%endpointaudit%'
      OR lower(COALESCE(user_agent,'')) LIKE '%mcpgrade%'
      OR lower(COALESCE(user_agent,'')) LIKE '%agentgrade%'
      OR lower(COALESCE(user_agent,'')) LIKE '%health%'
      OR lower(COALESCE(user_agent,'')) LIKE '%liveness%'
      OR lower(COALESCE(user_agent,'')) LIKE '%monitor%'
      OR lower(COALESCE(user_agent,'')) LIKE '%observatory%'
      OR lower(COALESCE(user_agent,'')) LIKE '%mcpbeat%'
      OR lower(COALESCE(user_agent,'')) LIKE '%stats-prober%'
      OR lower(COALESCE(user_agent,'')) GLOB '*[^a-z]bot[^a-z]*'
      OR lower(COALESCE(user_agent,'')) LIKE '%crawl%'
      OR lower(COALESCE(user_agent,'')) LIKE '%scrap%'
      OR lower(COALESCE(user_agent,'')) LIKE '%probe%'
      OR lower(COALESCE(user_agent,'')) LIKE '%census%'
      OR lower(COALESCE(user_agent,'')) LIKE '%witness%'
      OR lower(COALESCE(user_agent,'')) LIKE '%tripwire%'
      OR lower(COALESCE(user_agent,'')) LIKE '%research%'
      OR lower(COALESCE(user_agent,'')) LIKE '%reputation%'
      OR lower(COALESCE(user_agent,'')) LIKE '%measure-mcp%'
      THEN 'crawler_monitor'
    ELSE 'unknown'
  END,
  CASE
    WHEN lower(COALESCE(tool,'')) LIKE 'mcp:__verifymcp_auth_probe_%'
      OR lower(COALESCE(user_agent,'')) LIKE '%verifymcp%'
      OR client_key LIKE 'invalid:%' THEN 'auth'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%registry%' THEN 'registry'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%audit%'
      OR lower(COALESCE(user_agent,'')) LIKE '%scan%'
      OR lower(COALESCE(user_agent,'')) LIKE '%security%'
      OR lower(COALESCE(user_agent,'')) LIKE '%sentinel%'
      OR lower(COALESCE(user_agent,'')) LIKE '%endpointaudit%'
      OR lower(COALESCE(user_agent,'')) LIKE '%mcpgrade%'
      OR lower(COALESCE(user_agent,'')) LIKE '%agentgrade%' THEN 'audit'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%health%'
      OR lower(COALESCE(user_agent,'')) LIKE '%liveness%'
      OR lower(COALESCE(user_agent,'')) LIKE '%monitor%'
      OR lower(COALESCE(user_agent,'')) LIKE '%observatory%'
      OR lower(COALESCE(user_agent,'')) LIKE '%mcpbeat%'
      OR lower(COALESCE(user_agent,'')) LIKE '%stats-prober%' THEN 'health'
    WHEN external=1 AND (
      lower(COALESCE(user_agent,'')) GLOB '*[^a-z]bot[^a-z]*'
      OR lower(COALESCE(user_agent,'')) LIKE '%crawl%'
      OR lower(COALESCE(user_agent,'')) LIKE '%scrap%'
      OR lower(COALESCE(user_agent,'')) LIKE '%probe%'
      OR lower(COALESCE(user_agent,'')) LIKE '%census%'
      OR lower(COALESCE(user_agent,'')) LIKE '%witness%'
      OR lower(COALESCE(user_agent,'')) LIKE '%tripwire%'
      OR lower(COALESCE(user_agent,'')) LIKE '%research%'
      OR lower(COALESCE(user_agent,'')) LIKE '%reputation%'
      OR lower(COALESCE(user_agent,'')) LIKE '%measure-mcp%') THEN 'crawler'
    ELSE 'none'
  END,
  CASE
    WHEN external=0 THEN 'legacy_authenticated_internal'
    WHEN lower(COALESCE(tool,'')) LIKE 'mcp:__verifymcp_auth_probe_%'
      OR lower(COALESCE(user_agent,'')) LIKE '%verifymcp%' THEN 'legacy_verifymcp_auth_probe'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%registry%' THEN 'legacy_self_identified_registry'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%audit%'
      OR lower(COALESCE(user_agent,'')) LIKE '%scan%' THEN 'legacy_self_identified_audit'
    WHEN lower(COALESCE(user_agent,'')) LIKE '%health%'
      OR lower(COALESCE(user_agent,'')) LIKE '%liveness%'
      OR lower(COALESCE(user_agent,'')) LIKE '%monitor%'
      OR lower(COALESCE(user_agent,'')) LIKE '%mcpbeat%' THEN 'legacy_self_identified_health_monitor'
    ELSE 'legacy_unverifiable'
  END,
  0,
  COALESCE(client_key, 'legacy:unknown'),
  'UNKNOWN',
  CASE WHEN tool LIKE 'mcp:%' AND tool <> 'mcp:protocol' THEN 'tools/call' ELSE NULL END,
  CASE
    WHEN tool='/mcp' AND status=429 THEN 'rate_limited'
    WHEN tool='mcp:protocol' THEN 'legacy_protocol'
    WHEN tool LIKE 'mcp:%' THEN 'tools_call'
    ELSE 'legacy_protocol'
  END,
  CASE WHEN tool LIKE 'mcp:%' AND tool <> 'mcp:protocol' THEN substr(tool,5) ELSE NULL END,
  CASE WHEN tool IN (
    'mcp:check_dependency_upgrade',
    'mcp:find_safe_upgrade_target',
    'mcp:plan_dependency_upgrade'
  ) THEN substr(tool,5) ELSE NULL END,
  CASE WHEN tool IN (
    'mcp:check_dependency_upgrade',
    'mcp:find_safe_upgrade_target',
    'mcp:plan_dependency_upgrade'
  ) THEN 1 ELSE 0 END,
  NULL,
  NULL,
  'legacy_unverifiable',
  CASE WHEN external=0 THEN 1 ELSE 0 END,
  ecosystem,
  package,
  cache_hit,
  status,
  latency_ms,
  unknown_result,
  CASE
    WHEN client_key='owner' THEN 'owner'
    WHEN client_key LIKE 'invalid:%'
      OR lower(COALESCE(tool,'')) LIKE 'mcp:__verifymcp_auth_probe_%' THEN 'invalid_key'
    ELSE 'none'
  END,
  user_agent,
  referrer
FROM usage_events
WHERE surface='mcp';

-- Legacy Referer values may contain query strings. They are not needed for the
-- business funnel, so remove them rather than carrying possible secrets/PII.
UPDATE mcp_events SET referrer=NULL WHERE classification_version=0 AND referrer IS NOT NULL;
UPDATE usage_events SET referrer=NULL WHERE referrer IS NOT NULL;
