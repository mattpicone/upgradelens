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
  let body: { rows?: BreakingChangeInput[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "invalid_json", message: "Body must be JSON." } }, 400);
  }
  const rows = (body.rows ?? []).slice(0, 500);
  const now = new Date().toISOString();
  const stmts = rows
    .filter(
      (r) =>
        (r.ecosystem === "npm" || r.ecosystem === "pypi") &&
        typeof r.package === "string" &&
        r.package.length <= 214 &&
        typeof r.version === "string" &&
        r.version.length <= 64 &&
        typeof r.summary === "string" &&
        r.summary.length > 0 &&
        typeof r.source_url === "string" &&
        r.source_url.startsWith("https://"),
    )
    .map((r) =>
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
  if (stmts.length > 0) await c.env.DB.batch(stmts);
  return c.json({ ingested: stmts.length, skipped: rows.length - stmts.length });
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
