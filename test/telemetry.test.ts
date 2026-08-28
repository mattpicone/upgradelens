import { describe, expect, it } from "vitest";
import { checkKeyIssuance, checkRateLimit, reserveCacheMiss } from "../src/telemetry";
import { fakeEnv } from "./helpers";

function counterDb(seed: Record<string, number> = {}): { db: D1Database; counters: Map<string, number> } {
  const counters = new Map(Object.entries(seed));
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind: (...values: unknown[]) => {
        args = values;
        return stmt;
      },
      first: async () => {
        if (!sql.includes("SELECT count FROM rate_counters")) return null;
        const count = counters.get(String(args[0]));
        return count === undefined ? null : { count };
      },
      run: async () => {
        const bucket = String(args[0]);
        const current = counters.get(bucket) ?? 0;
        let increment = 1;
        let cap = Infinity;
        if (sql.includes("count + excluded.count <= ?")) {
          increment = Number(args[1]);
          cap = Number(args[3]);
        } else if (sql.includes("WHERE count < 2")) {
          cap = 2;
        } else if (sql.includes("WHERE count < ?")) {
          cap = Number(args[2]);
        }
        if (current + increment > cap) return { results: [], success: true, meta: {} };
        const count = current + increment;
        counters.set(bucket, count);
        return { results: [{ count }], success: true, meta: {} };
      },
      all: async () => ({ results: [], success: true, meta: {} }),
      raw: async () => [],
    };
    return stmt;
  };
  return {
    counters,
    db: { prepare } as unknown as D1Database,
  };
}

describe("quota hardening", () => {
  it("stops writing a caller counter after the daily limit", async () => {
    const { db, counters } = counterDb();
    const env = fakeEnv({ DB: db });
    const caller = {
      clientKey: "anon:test",
      internal: false,
      keyed: false,
      plan: "anon",
      dailyQuota: 2,
    };
    expect((await checkRateLimit(env, caller, { skipEdge: true })).allowed).toBe(true);
    expect((await checkRateLimit(env, caller, { skipEdge: true })).allowed).toBe(true);
    expect((await checkRateLimit(env, caller, { skipEdge: true })).allowed).toBe(false);
    expect((await checkRateLimit(env, caller, { skipEdge: true })).allowed).toBe(false);
    const bucket = [...counters.keys()].find((key) => key.startsWith("d:"));
    expect(counters.get(bucket!)).toBe(2);
  });

  it("does not increment exhausted key-issuance counters", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const bucket = `k:${day}:anon:test`;
    const { db, counters } = counterDb({ [bucket]: 2 });
    const env = fakeEnv({ DB: db });
    const result = await checkKeyIssuance(env, {
      clientKey: "anon:test",
      internal: false,
      keyed: false,
      plan: "anon",
      dailyQuota: 100,
    });
    expect(result.allowed).toBe(false);
    expect(counters.get(bucket)).toBe(2);
  });

  it("does not increment the exhausted cache-miss fuse", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const bucket = `g:${day}:miss`;
    const { db, counters } = counterDb({ [bucket]: 1000 });
    expect(await reserveCacheMiss(fakeEnv({ DB: db }))).toBe(false);
    expect(counters.get(bucket)).toBe(1000);
  });
});
