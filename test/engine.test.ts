// Golden upgrade-pair tests against fixture payloads shaped like the real
// upstream APIs (deps.dev, npm, PyPI, OSV, endoflife.date).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeUpgrade } from "../src/engine/analyze";

type RouteMap = Record<string, unknown | ((body: string) => unknown)>;

function mockFetch(routes: RouteMap, opts: { failUnmatched?: boolean } = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        const data =
          typeof handler === "function"
            ? (handler as (b: string) => unknown)(String(init?.body ?? ""))
            : handler;
        if (data === 404) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    if (opts.failUnmatched) return new Response("upstream down", { status: 503 });
    return new Response("not found", { status: 404 });
  });
}

const depsDevExpress = {
  packageKey: { name: "express" },
  versions: [
    { versionKey: { version: "4.18.0" }, publishedAt: "2022-04-25T00:00:00Z", isDefault: false },
    { versionKey: { version: "4.19.2" }, publishedAt: "2024-03-25T00:00:00Z", isDefault: false },
    { versionKey: { version: "4.21.2" }, publishedAt: "2024-12-01T00:00:00Z", isDefault: false },
    { versionKey: { version: "5.0.0-beta.3" }, publishedAt: "2024-03-26T00:00:00Z", isDefault: false },
    { versionKey: { version: "5.1.0" }, publishedAt: "2025-03-31T00:00:00Z", isDefault: true },
  ],
};

const npmExpress4 = {
  version: "4.19.2",
  engines: { node: ">= 0.10.0" },
  dependencies: { accepts: "~1.3.8", "body-parser": "1.20.2", qs: "6.11.0" },
  license: "MIT",
  repository: { url: "git+https://github.com/expressjs/express.git" },
};

const npmExpress5 = {
  version: "5.1.0",
  engines: { node: ">= 18" },
  dependencies: { accepts: "^2.0.0", "body-parser": "^2.2.0", qs: "^6.14.0", router: "^2.2.0" },
  license: "MIT",
  repository: { url: "git+https://github.com/expressjs/express.git" },
};

const osvEmpty = { results: [{}, {}] };

const eolExpress = [
  { cycle: "5", eol: false, latest: "5.1.0" },
  { cycle: "4", eol: "2026-12-31", latest: "4.21.2" },
];

describe("golden: express 4.19.2 -> 5.1.0 (major, clean)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "https://api.deps.dev/v3/systems/npm/packages/express": depsDevExpress,
        "https://registry.npmjs.org/express/4.19.2": npmExpress4,
        "https://registry.npmjs.org/express/5.1.0": npmExpress5,
        "https://api.osv.dev/v1/querybatch": osvEmpty,
        "https://endoflife.date/api/express.json": eolExpress,
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns review_required with evidence for a clean major jump", async () => {
    const r = await analyzeUpgrade({
      ecosystem: "npm",
      package: "express",
      current_version: "4.19.2",
      target_version: "5.1.0",
      runtime: { node: "20.11.0" },
    });
    expect(r.decision).toBe("review_required");
    expect(r.version_facts.semver_jump).toBe("major");
    expect(r.latest_stable).toBe("5.1.0");
    expect(r.repository_url).toBe("https://github.com/expressjs/express");
    expect(r.compatibility.runtime_supported).toBe(true);
    expect(r.compatibility.dependency_changes?.added).toContain("router");
    expect(r.evidence.length).toBeGreaterThan(2);
    expect(r.risk_score).toBeGreaterThanOrEqual(30);
    expect(r.reasons.join(" ")).toMatch(/Major version jump/);
    // every evidence entry must carry provenance
    for (const e of r.evidence) {
      expect(e.source_url).toMatch(/^https:\/\//);
      expect(e.fetched_at).toBeTruthy();
    }
  });

  it("blocks when the runtime does not satisfy the target requirement", async () => {
    const r = await analyzeUpgrade({
      ecosystem: "npm",
      package: "express",
      current_version: "4.19.2",
      target_version: "5.1.0",
      runtime: { node: "16.20.0" },
    });
    expect(r.decision).toBe("block");
    expect(r.compatibility.runtime_supported).toBe(false);
    expect(r.risk_score).toBeGreaterThanOrEqual(70);
  });

  it("proceeds for a same-version no-op", async () => {
    const r = await analyzeUpgrade({
      ecosystem: "npm",
      package: "express",
      current_version: "4.19.2",
      target_version: "4.19.2",
    });
    expect(r.decision).toBe("proceed");
    expect(r.version_facts.semver_jump).toBe("none");
  });
});

describe("golden: security-fixing patch upgrade", () => {
  const GHSA = {
    id: "GHSA-35jh-r3h4-6jhm",
    summary: "Command injection in lodash",
    aliases: ["CVE-2021-23337"],
    database_specific: { severity: "HIGH" },
  };
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "https://api.deps.dev/v3/systems/npm/packages/lodash": {
          packageKey: { name: "lodash" },
          versions: [
            { versionKey: { version: "4.17.20" }, publishedAt: "2020-08-13T00:00:00Z", isDefault: false },
            { versionKey: { version: "4.17.21" }, publishedAt: "2021-02-20T00:00:00Z", isDefault: true },
          ],
        },
        "https://registry.npmjs.org/lodash/4.17.20": {
          version: "4.17.20",
          dependencies: {},
          license: "MIT",
        },
        "https://registry.npmjs.org/lodash/4.17.21": {
          version: "4.17.21",
          dependencies: {},
          license: "MIT",
        },
        "https://api.osv.dev/v1/querybatch": (body: string) => {
          const q = JSON.parse(body) as { queries: { version: string }[] };
          return {
            results: q.queries.map((query) =>
              query.version === "4.17.20" ? { vulns: [{ id: GHSA.id }] } : {},
            ),
          };
        },
        "https://api.osv.dev/v1/query": (body: string) => {
          const q = JSON.parse(body) as { version: string };
          return q.version === "4.17.20" ? { vulns: [GHSA] } : { vulns: [] };
        },
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("proceeds and reports the fixed advisory", async () => {
    const r = await analyzeUpgrade({
      ecosystem: "npm",
      package: "lodash",
      current_version: "4.17.20",
      target_version: "4.17.21",
    });
    expect(r.decision).toBe("proceed");
    expect(r.security_delta.advisories_fixed_by_target.map((a) => a.id)).toContain(GHSA.id);
    expect(r.security_delta.advisories_affecting_target).toHaveLength(0);
    expect(r.reasons.join(" ")).toMatch(/fixes 1 known advisory/);
  });

  it("blocks a downgrade that reintroduces the advisory", async () => {
    const r = await analyzeUpgrade({
      ecosystem: "npm",
      package: "lodash",
      current_version: "4.17.21",
      target_version: "4.17.20",
    });
    expect(r.decision).toBe("block");
    expect(r.version_facts.is_downgrade).toBe(true);
    expect(r.security_delta.advisories_affecting_target.map((a) => a.id)).toContain(GHSA.id);
  });
});

describe("golden: pypi django with requires_python", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "https://api.deps.dev/v3/systems/pypi/packages/django": {
          packageKey: { name: "django" },
          versions: [
            { versionKey: { version: "3.2.25" }, publishedAt: "2024-03-04T00:00:00Z", isDefault: false },
            { versionKey: { version: "5.0.7" }, publishedAt: "2024-07-09T00:00:00Z", isDefault: true },
          ],
        },
        "https://pypi.org/pypi/django/3.2.25/json": {
          info: {
            version: "3.2.25",
            requires_python: ">=3.6",
            requires_dist: ["asgiref (<4,>=3.3.2)", "pytz", "sqlparse (>=0.2.2)"],
            license: "BSD-3-Clause",
            project_urls: { Source: "https://github.com/django/django" },
          },
          urls: [{ upload_time_iso_8601: "2024-03-04T00:00:00Z" }],
        },
        "https://pypi.org/pypi/django/5.0.7/json": {
          info: {
            version: "5.0.7",
            requires_python: ">=3.10",
            requires_dist: ["asgiref<4,>=3.7.0", "sqlparse>=0.3.1"],
            license: "BSD-3-Clause",
            project_urls: { Source: "https://github.com/django/django" },
          },
          urls: [{ upload_time_iso_8601: "2024-07-09T00:00:00Z" }],
        },
        "https://api.osv.dev/v1/querybatch": osvEmpty,
        "https://endoflife.date/api/django.json": [
          { cycle: "5.0", eol: "2025-04-30" },
          { cycle: "3.2", eol: "2024-04-01" },
        ],
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("blocks when python runtime is too old", async () => {
    const r = await analyzeUpgrade({
      ecosystem: "pypi",
      package: "django",
      current_version: "3.2.25",
      target_version: "5.0.7",
      runtime: { python: "3.8" },
    });
    expect(r.decision).toBe("block");
    expect(r.compatibility.runtime_supported).toBe(false);
  });

  it("review_required for a compatible major jump and detects dep removal", async () => {
    const r = await analyzeUpgrade({
      ecosystem: "pypi",
      package: "django",
      current_version: "3.2.25",
      target_version: "5.0.7",
      runtime: { python: "3.12" },
    });
    expect(r.decision).toBe("review_required");
    expect(r.compatibility.runtime_supported).toBe(true);
    expect(r.compatibility.dependency_changes?.removed).toContain("pytz");
  });
});

describe("failure handling", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("blocks when the target version does not exist (404)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        "https://api.deps.dev/v3/systems/npm/packages/express": depsDevExpress,
        "https://registry.npmjs.org/express/4.19.2": npmExpress4,
        "https://registry.npmjs.org/express/99.0.0": 404,
        "https://api.osv.dev/v1/querybatch": osvEmpty,
        "https://endoflife.date/api/express.json": eolExpress,
      }),
    );
    const r = await analyzeUpgrade({
      ecosystem: "npm",
      package: "express",
      current_version: "4.19.2",
      target_version: "99.0.0",
    });
    expect(r.decision).toBe("block");
    expect(r.reasons.join(" ")).toMatch(/not found/);
  });

  it("returns unknown rather than guessing when upstreams are down", async () => {
    vi.stubGlobal("fetch", mockFetch({}, { failUnmatched: true }));
    const r = await analyzeUpgrade({
      ecosystem: "npm",
      package: "express",
      current_version: "4.19.2",
      target_version: "5.1.0",
    });
    expect(r.decision).toBe("unknown");
    expect(r.confidence).toBeLessThanOrEqual(0.5);
  });

  it("degrades confidence but still answers when OSV is down", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        {
          "https://api.deps.dev/v3/systems/npm/packages/express": depsDevExpress,
          "https://registry.npmjs.org/express/4.19.2": npmExpress4,
          "https://registry.npmjs.org/express/4.21.2": {
            version: "4.21.2",
            engines: { node: ">= 0.10.0" },
            dependencies: npmExpress4.dependencies,
            license: "MIT",
          },
          "https://endoflife.date/api/express.json": eolExpress,
        },
        { failUnmatched: true },
      ),
    );
    const r = await analyzeUpgrade({
      ecosystem: "npm",
      package: "express",
      current_version: "4.19.2",
      target_version: "4.21.2",
    });
    expect(r.decision).not.toBe("unknown"); // minor jump can still be assessed
    expect(r.confidence).toBeLessThan(0.9);
    expect(r.reasons.join(" ")).toMatch(/OSV/);
  });
});
