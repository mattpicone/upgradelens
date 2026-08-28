import { afterEach, describe, expect, it, vi } from "vitest";
import { findSafeTarget } from "../src/engine/target";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("target candidate safety", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("marks every candidate unknown when OSV is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deps.dev")) {
        return json({
          packageKey: { name: "demo" },
          versions: [
            { versionKey: { version: "1.0.0" }, isDefault: false },
            { versionKey: { version: "1.1.0" }, isDefault: false },
            { versionKey: { version: "2.0.0" }, isDefault: true },
          ],
        });
      }
      return new Response("down", { status: 503 });
    }));
    const r = await findSafeTarget("npm", "demo", "1.0.0");
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates.every((c) => c.decision === "unknown")).toBe(true);
    expect(r.candidates.every((c) => c.requires_full_check)).toBe(true);
    expect(r.coverage.osv.status).toBe("unavailable");
  });

  it("respects PyPI epochs and max_major_jump", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.deps.dev")) {
        return json({
          packageKey: { name: "demo" },
          versions: [
            { versionKey: { version: "1!2.0" }, isDefault: false },
            { versionKey: { version: "1!3.0" }, isDefault: false },
            { versionKey: { version: "1!4.0" }, isDefault: false },
            { versionKey: { version: "2!1.0" }, isDefault: true },
          ],
        });
      }
      if (url.includes("api.osv.dev")) return json({ results: [{}, {}] });
      return new Response("not found", { status: 404 });
    }));
    const r = await findSafeTarget("pypi", "demo", "1!2.0", { maxMajorJump: 1 });
    expect(r.candidates.map((c) => c.version)).toContain("1!3.0");
    expect(r.candidates.map((c) => c.version)).not.toContain("1!4.0");
    expect(r.candidates.map((c) => c.version)).not.toContain("2!1.0");
  });
});
