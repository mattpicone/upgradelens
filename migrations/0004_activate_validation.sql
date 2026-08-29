-- Start the clean business-validation clock only after the new Worker is
-- deployed and its DB/telemetry health check passes. Reapplying this migration
-- preserves the original active experiment start.

INSERT INTO experiments (name, variant, started_at, metrics_json)
SELECT
  'organic_mcp_validation',
  'classification_v1',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  '{"business_definition":"successful known external MCP tool invocation; internal, verification, invalid-auth, owned-test and legacy traffic excluded"}'
WHERE NOT EXISTS (
  SELECT 1 FROM experiments WHERE name='organic_mcp_validation' AND ended_at IS NULL
);
