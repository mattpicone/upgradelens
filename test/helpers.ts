// Test doubles: an in-memory no-op D1 and an Env suitable for app.request().

import type { Env } from "../src/types";

export function fakeD1(): D1Database {
  const stmt = {
    bind: (..._args: unknown[]) => stmt,
    first: async () => null,
    all: async () => ({ results: [], success: true, meta: {} }),
    run: async () => ({ results: [], success: true, meta: {} }),
    raw: async () => [],
  };
  return {
    prepare: (_sql: string) => stmt,
    batch: async (stmts: unknown[]) => stmts.map(() => ({ results: [], success: true, meta: {} })),
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0),
    withSession: () => ({}) as never,
  } as unknown as D1Database;
}

export function fakeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: fakeD1(),
    ANALYSIS_VERSION: "1",
    SERVICE_VERSION: "0.1.0-test",
    PAYMENTS_ENABLED: "false",
    PUBLIC_BASE_URL: "https://upgradelens.test",
    OWNER_TOKEN: "test-owner-token",
    ...overrides,
  };
}

export const fakeCtx = {
  waitUntil: (_p: Promise<unknown>) => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;
