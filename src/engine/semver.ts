// npm package versions and Node engine ranges follow the npm/node-semver
// implementation. Keep this wrapper small so all ordering/range behavior is
// inherited from the ecosystem reference rather than reimplemented here.

import {
  compare as compareNodeSemver,
  parse as parseNodeSemver,
  satisfies as satisfiesNodeRange,
  validRange,
} from "semver";

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  raw: string;
}

// Runtime versions are commonly supplied as "18" or "18.19". Package versions
// remain strict and are never completed; only the runtime range check uses this.
function completePartial(input: string): string {
  const trimmed = input.trim();
  const m = /^(v?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!m) return trimmed;
  return `${m[1]}${m[2]}.${m[3] ?? "0"}.0`;
}

export function parseSemver(input: string): SemVer | null {
  const parsed = parseNodeSemver(input.trim(), { loose: false });
  if (!parsed) return null;
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: [...parsed.prerelease],
    raw: input.trim(),
  };
}

export function compareSemver(a: SemVer, b: SemVer): number {
  const render = (v: SemVer) =>
    `${v.major}.${v.minor}.${v.patch}${
      v.prerelease.length > 0 ? `-${v.prerelease.join(".")}` : ""
    }`;
  return compareNodeSemver(render(a), render(b));
}

export function compareVersions(a: string, b: string): number | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  return compareSemver(pa, pb);
}

export type Jump = "major" | "minor" | "patch" | "prerelease" | "none" | "unknown";

export function classifyJump(from: string, to: string): Jump {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return "unknown";
  if (compareSemver(a, b) === 0) return "none";
  if (b.major !== a.major) return "major";
  if (b.minor !== a.minor) return "minor";
  if (b.patch !== a.patch) return "patch";
  return "prerelease";
}

export function isPrerelease(v: string): boolean {
  return (parseSemver(v)?.prerelease.length ?? 0) > 0;
}

export function satisfiesRange(version: string, range: string): boolean | null {
  const parsed = parseNodeSemver(completePartial(version), { loose: false });
  if (!parsed) return null;
  let normalizedRange: string | null;
  try {
    normalizedRange = validRange(range, { loose: false });
  } catch {
    return null;
  }
  if (normalizedRange === null) return null;
  const canonical = `${parsed.major}.${parsed.minor}.${parsed.patch}${
    parsed.prerelease.length > 0 ? `-${parsed.prerelease.join(".")}` : ""
  }`;
  return satisfiesNodeRange(canonical, normalizedRange, {
    loose: false,
    includePrerelease: false,
  });
}
