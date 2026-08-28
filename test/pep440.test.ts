import { describe, expect, it } from "vitest";
import {
  parsePep440,
  compareVersionsPy,
  classifyJumpPy,
  isPrereleasePy,
  satisfiesPySpec,
} from "../src/engine/pep440";

describe("parsePep440", () => {
  it("parses release versions", () => {
    expect(parsePep440("3.2.1")).toMatchObject({ release: [3, 2, 1] });
    expect(parsePep440("2024.1")).toMatchObject({ release: [2024, 1] });
  });
  it("parses pre/post/dev segments", () => {
    expect(parsePep440("5.0rc1")).toMatchObject({ preKind: "rc", preNum: 1 });
    expect(parsePep440("5.0a2")).toMatchObject({ preKind: "a", preNum: 2 });
    expect(parsePep440("1.0.post1")).toMatchObject({ post: 1 });
    expect(parsePep440("1.0.dev3")).toMatchObject({ dev: 3 });
  });
  it("parses epochs and local versions", () => {
    expect(parsePep440("1!2.0")).toMatchObject({ epoch: 1 });
    expect(parsePep440("1.0+local.1")).toMatchObject({ release: [1, 0] });
  });
  it("rejects garbage", () => {
    expect(parsePep440("not.a.version!")).toBeNull();
  });
});

describe("compareVersionsPy", () => {
  it("orders release versions", () => {
    expect(compareVersionsPy("3.2", "3.10")).toBeLessThan(0);
    expect(compareVersionsPy("5.0", "4.2.9")).toBeGreaterThan(0);
    expect(compareVersionsPy("1.0", "1.0.0")).toBe(0);
  });
  it("orders dev < pre < final < post", () => {
    expect(compareVersionsPy("5.0.dev1", "5.0a1")).toBeLessThan(0);
    expect(compareVersionsPy("5.0a1", "5.0b1")).toBeLessThan(0);
    expect(compareVersionsPy("5.0rc1", "5.0")).toBeLessThan(0);
    expect(compareVersionsPy("5.0", "5.0.post1")).toBeLessThan(0);
  });
  it("respects epochs", () => {
    expect(compareVersionsPy("1!1.0", "2.0")).toBeGreaterThan(0);
  });
});

describe("classifyJumpPy", () => {
  it("classifies", () => {
    expect(classifyJumpPy("3.2.25", "5.0.7")).toBe("major");
    expect(classifyJumpPy("5.0", "5.1")).toBe("minor");
    expect(classifyJumpPy("5.1.1", "5.1.2")).toBe("patch");
  });
});

describe("isPrereleasePy", () => {
  it("detects prereleases", () => {
    expect(isPrereleasePy("5.0rc1")).toBe(true);
    expect(isPrereleasePy("5.0.dev1")).toBe(true);
    expect(isPrereleasePy("5.0")).toBe(false);
  });
});

describe("satisfiesPySpec (requires_python style)", () => {
  it("handles >= specs", () => {
    expect(satisfiesPySpec("3.12", ">=3.9")).toBe(true);
    expect(satisfiesPySpec("3.8", ">=3.9")).toBe(false);
  });
  it("handles comma AND", () => {
    expect(satisfiesPySpec("3.11", ">=3.8,<4")).toBe(true);
    expect(satisfiesPySpec("4.0", ">=3.8,<4")).toBe(false);
  });
  it("handles wildcard exclusion", () => {
    expect(satisfiesPySpec("3.0.1", "!=3.0.*,>=2.7")).toBe(false);
    expect(satisfiesPySpec("3.1", "!=3.0.*,>=2.7")).toBe(true);
  });
  it("handles compatible release ~=", () => {
    expect(satisfiesPySpec("3.10.4", "~=3.10")).toBe(true);
    expect(satisfiesPySpec("4.0", "~=3.10")).toBe(false);
  });
  it("returns null when unevaluable", () => {
    expect(satisfiesPySpec("garbage", ">=3.9")).toBeNull();
  });
});
