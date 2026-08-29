// Internal ingestion endpoint used by the scheduled GitHub Actions enrichment
// job. Auth: ADMIN_KEY secret. Never exposed in public documentation.

import { Hono } from "hono";
import type { Env } from "../types";
import type { AppVariables } from "../context";

export const admin = new Hono<{ Bindings: Env; Variables: AppVariables }>();

admin.use("*", async (c, next) => {
  const key = c.req.header("x-admin-key") ?? "";
  if (!c.env.ADMIN_KEY || key !== c.env.ADMIN_KEY) {
    return c.json({ error: { code: "unauthorized", message: "Admin key required." } }, 401);
  }
  await next();
});

interface BreakingChangeInput {
  ecosystem: string;
  package: string;
  version: string;
  summary: string;
  severity?: string;
  source_url: string;
  confidence?: number;
}

admin.post("/breaking-changes", async (c) => {
  let body: {
    rows?: unknown[];
    replace?: boolean;
    ecosystem?: string;
    package?: string;
  };
  try {
    const parsed: unknown = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return c.json({ error: { code: "invalid_request", message: "Body must be a JSON object." } }, 400);
    }
    body = parsed as typeof body;
  } catch {
    return c.json({ error: { code: "invalid_json", message: "Body must be JSON." } }, 400);
  }
  if (!Array.isArray(body.rows)) {
    return c.json({ error: { code: "invalid_request", message: "rows must be an array." } }, 400);
  }
  if (body.rows.length > 500) {
    return c.json({ error: { code: "too_many_rows", message: "At most 500 rows may be ingested at once." } }, 400);
  }
  const rows = body.rows;
  const now = new Date().toISOString();
  const valid = (value: unknown): value is BreakingChangeInput => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const r = value as Partial<BreakingChangeInput>;
    return (r.ecosystem === "npm" || r.ecosystem === "pypi") &&
    typeof r.package === "string" &&
    r.package.length > 0 &&
    r.package.length <= 214 &&
    typeof r.version === "string" &&
    r.version.length > 0 &&
    r.version.length <= 64 &&
    typeof r.summary === "string" &&
    r.summary.length > 0 &&
    typeof r.source_url === "string" &&
    r.source_url.startsWith("https://");
  };
  const accepted = rows.filter(valid);

  if (body.replace) {
    const targetValid =
      (body.ecosystem === "npm" || body.ecosystem === "pypi") &&
      typeof body.package === "string" &&
      body.package.length > 0 &&
      body.package.length <= 214;
    const allRowsMatch = accepted.every(
      (r) => r.ecosystem === body.ecosystem && r.package === body.package,
    );
    if (!targetValid || accepted.length !== rows.length || !allRowsMatch) {
      return c.json(
        {
          error: {
            code: "invalid_replace",
            message: "A replacement requires a valid ecosystem/package and only valid rows for that exact package.",
          },
        },
        400,
      );
    }
  }

  const inserts = accepted.map((r) =>
      c.env.DB.prepare(
        `INSERT INTO breaking_changes (ecosystem, package, version, summary, severity, source_url, confidence, fetched_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(ecosystem, package, version, summary) DO UPDATE SET
           severity=excluded.severity, source_url=excluded.source_url,
           confidence=excluded.confidence, fetched_at=excluded.fetched_at`,
      ).bind(
        r.ecosystem,
        r.package,
        r.version,
        r.summary.slice(0, 300),
        (r.severity ?? "unknown").slice(0, 20),
        r.source_url.slice(0, 500),
        Math.min(1, Math.max(0, r.confidence ?? 0.8)),
        now,
      ),
    );
  const stmts = body.replace
    ? [
        c.env.DB.prepare(
          `DELETE FROM breaking_changes WHERE ecosystem = ? AND package = ?`,
        ).bind(body.ecosystem, body.package),
        ...inserts,
      ]
    : inserts;
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return c.json({
    ingested: inserts.length,
    skipped: rows.length - accepted.length,
    replaced: body.replace === true,
  });
});

admin.post("/refresh-source-snapshot", async (c) => {
  const { source } = (await c.req.json().catch(() => ({}))) as { source?: string };
  if (!source || !/^[a-z_]{1,30}$/.test(source)) {
    return c.json({ error: { code: "invalid_request", message: "source required" } }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO source_snapshots (source, last_success_at) VALUES (?, ?)
     ON CONFLICT(source) DO UPDATE SET last_success_at=excluded.last_success_at`,
  )
    .bind(source, new Date().toISOString())
    .run();
  return c.json({ ok: true });
});
