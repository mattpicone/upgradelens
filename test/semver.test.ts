import { describe, expect, it } from "vitest";
import {
  parseSemver,
  compareVersions,
  classifyJump,
  isPrerelease,
  satisfiesRange,
} from "../src/engine/semver";

describe("parseSemver", () => {
  it("parses standard versions", () => {
    expect(parseSemver("1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver("v18.19.1")).toMatchObject({ major: 18, minor: 19, patch: 1 });
  });
  it("parses prerelease and build metadata", () => {
    expect(parseSemver("5.0.0-beta.1")).toMatchObject({ prerelease: ["beta", 1] });
    expect(parseSemver("1.0.0+build.5")).toMatchObject({ major: 1, prerelease: [] });
  });
  it("tolerates loose versions", () => {
    expect(parseSemver("2")).toMatchObject({ major: 2, minor: 0, patch: 0 });
    expect(parseSemver("3.1")).toMatchObject({ major: 3, minor: 1, patch: 0 });
  });
  it("rejects garbage", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("")).toBeNull();
    expect(parseSemver("1.2.3.4.5.x")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders correctly", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBeLessThan(0);
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
  it("prerelease sorts before release", () => {
    expect(compareVersions("5.0.0-beta.1", "5.0.0")).toBeLessThan(0);
    expect(compareVersions("5.0.0-alpha", "5.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("5.0.0-beta.2", "5.0.0-beta.11")).toBeLessThan(0);
  });
});

describe("classifyJump", () => {
  it("classifies jumps", () => {
    expect(classifyJump("4.19.2", "5.1.0")).toBe("major");
    expect(classifyJump("4.18.0", "4.19.2")).toBe("minor");
    expect(classifyJump("4.19.1", "4.19.2")).toBe("patch");
    expect(classifyJump("1.0.0", "1.0.0")).toBe("none");
    expect(classifyJump("x", "5.0.0")).toBe("unknown");
  });
});

describe("isPrerelease", () => {
  it("detects prereleases", () => {
    expect(isPrerelease("5.0.0-rc.1")).toBe(true);
    expect(isPrerelease("5.0.0")).toBe(false);
  });
});

describe("satisfiesRange (engines.node style)", () => {
  it("handles >= ranges", () => {
    expect(satisfiesRange("20.11.0", ">=18")).toBe(true);
    expect(satisfiesRange("16.0.0", ">=18")).toBe(false);
  });
  it("handles OR ranges", () => {
    expect(satisfiesRange("14.21.3", "^14.18.0 || >=16.0.0")).toBe(true);
    expect(satisfiesRange("15.0.0", "^14.18.0 || >=16.0.0")).toBe(false);
    expect(satisfiesRange("18.0.0", "^14.18.0 || >=16.0.0")).toBe(true);
  });
  it("handles caret/tilde", () => {
    expect(satisfiesRange("4.5.0", "^4.2.0")).toBe(true);
    expect(satisfiesRange("5.0.0", "^4.2.0")).toBe(false);
    expect(satisfiesRange("1.2.9", "~1.2.3")).toBe(true);
    expect(satisfiesRange("1.3.0", "~1.2.3")).toBe(false);
  });
  it("handles wildcard and AND", () => {
    expect(satisfiesRange("9.9.9", "*")).toBe(true);
    expect(satisfiesRange("18.5.0", ">=18 <19")).toBe(true);
    expect(satisfiesRange("19.0.0", ">=18 <19")).toBe(false);
  });
  it("handles hyphen ranges and plain majors", () => {
    expect(satisfiesRange("2.5.0", "2 - 3")).toBe(true);
    expect(satisfiesRange("18.7.1", "18")).toBe(true);
    expect(satisfiesRange("19.0.0", "18")).toBe(false);
  });
  it("returns null for unparseable input", () => {
    expect(satisfiesRange("garbage", ">=18")).toBeNull();
  });
});
