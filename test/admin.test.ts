import { describe, expect, it } from "vitest";
import { app } from "../src/index";
import { fakeCtx, fakeEnv } from "./helpers";

function recordingDb() {
  const prepared: { sql: string; args: unknown[] }[] = [];
  const batches: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, args: [] as unknown[] };
      prepared.push(call);
      const statement = {
        bind(...args: unknown[]) {
          call.args = args;
          return statement;
        },
        first: async () => null,
        all: async () => ({ results: [], success: true, meta: {} }),
        run: async () => ({ results: [], success: true, meta: {} }),
        raw: async () => [],
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      batches.push(statements);
      return statements.map(() => ({ results: [], success: true, meta: {} }));
    },
  } as unknown as D1Database;
  return { db, prepared, batches };
}

const request = (body: unknown, db: D1Database) =>
  app.request(
    "/admin/breaking-changes",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": "test-admin-key",
      },
      body: JSON.stringify(body),
    },
    fakeEnv({ DB: db, ADMIN_KEY: "test-admin-key" }),
    fakeCtx,
  );

describe("breaking-change enrichment ingestion", () => {
  it("atomically replaces a curated package snapshot, including with zero facts", async () => {
    const { db, prepared, batches } = recordingDb();
    const response = await request(
      { replace: true, ecosystem: "npm", package: "express", rows: [] },
      db,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ingested: 0, replaced: true });
    expect(prepared.some((call) => /DELETE FROM breaking_changes/.test(call.sql))).toBe(true);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
  });

  it("rejects replacement rows for a different package before deleting data", async () => {
    const { db, prepared, batches } = recordingDb();
    const response = await request(
      {
        replace: true,
        ecosystem: "npm",
        package: "express",
        rows: [
          {
            ecosystem: "npm",
            package: "react",
            version: "19.0.0",
            summary: "Remove the legacy renderer API.",
            source_url: "https://github.com/facebook/react/releases/tag/v19.0.0",
          },
        ],
      },
      db,
    );

    expect(response.status).toBe(400);
    expect(prepared.some((call) => /DELETE FROM breaking_changes/.test(call.sql))).toBe(false);
    expect(batches).toHaveLength(0);
  });

  it("requires the admin secret", async () => {
    const response = await app.request(
      "/admin/breaking-changes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: [] }),
      },
      fakeEnv({ ADMIN_KEY: "test-admin-key" }),
      fakeCtx,
    );
    expect(response.status).toBe(401);
  });
});
