// Compact, dependency-free semver implementation covering the subset needed
// for upgrade analysis: parse, compare, jump classification and simple range
// satisfaction for `engines.node`-style expressions.

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
  raw: string;
}

const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+[0-9A-Za-z-.]+)?$/;

export function parseSemver(input: string): SemVer | null {
  const m = SEMVER_RE.exec(input.trim());
  if (!m) return loose(input);
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4]
      ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p))
      : [],
    raw: input.trim(),
  };
}

// Tolerate "1", "1.2" style versions occasionally seen in registries.
function loose(input: string): SemVer | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(input.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    prerelease: [],
    raw: input.trim(),
  };
}

function cmpIdent(a: string | number, b: string | number): number {
  const an = typeof a === "number";
  const bn = typeof b === "number";
  if (an && bn) return (a as number) - (b as number);
  if (an) return -1; // numeric identifiers sort before alphanumeric
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // no prerelease > prerelease
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const ai = a.prerelease[i];
    const bi = b.prerelease[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    const c = cmpIdent(ai, bi);
    if (c !== 0) return c;
  }
  return 0;
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
  const p = parseSemver(v);
  return p ? p.prerelease.length > 0 : false;
}

// --- Minimal range satisfaction for engines-style ranges -------------------
// Supports: "*", "x", ">=X", ">X", "<=X", "<X", "=X", "^X", "~X", plain "X",
// hyphen ranges "A - B", space-separated AND, "||"-separated OR.

interface Comparator {
  op: ">=" | ">" | "<=" | "<" | "=";
  v: SemVer;
}

function expandPart(part: string): Comparator[] | null {
  part = part.trim();
  if (part === "" || part === "*" || part === "x" || part === "X") return [];
  let m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-([0-9A-Za-z-.]+))?$/.exec(
    part,
  );
  if (!m) return null;
  const op = m[1] ?? "";
  const maj = Number(m[2]);
  const minRaw = m[3];
  const patRaw = m[4];
  const pre = m[5] ? m[5].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  const minor = minRaw === undefined || minRaw === "x" || minRaw === "*" ? null : Number(minRaw);
  const patch = patRaw === undefined || patRaw === "x" || patRaw === "*" ? null : Number(patRaw);
  const base: SemVer = {
    major: maj,
    minor: minor ?? 0,
    patch: patch ?? 0,
    prerelease: pre,
    raw: part,
  };
  const zero = (v: Partial<SemVer>): SemVer => ({
    major: v.major ?? 0,
    minor: v.minor ?? 0,
    patch: v.patch ?? 0,
    prerelease: v.prerelease ?? [],
    raw: "",
  });
  switch (op) {
    case ">=":
    case ">":
    case "<=":
    case "<":
      return [{ op, v: base }];
    case "^": {
      let upper: SemVer;
      if (maj > 0) upper = zero({ major: maj + 1 });
      else if ((minor ?? 0) > 0) upper = zero({ minor: (minor ?? 0) + 1 });
      else upper = zero({ patch: (patch ?? 0) + 1 });
      return [
        { op: ">=", v: base },
        { op: "<", v: upper },
      ];
    }
    case "~": {
      const upper =
        minor === null ? zero({ major: maj + 1 }) : zero({ major: maj, minor: minor + 1 });
      return [
        { op: ">=", v: base },
        { op: "<", v: upper },
      ];
    }
    default: {
      // plain or "=" — wildcard components widen the range
      if (minor === null) {
        return [
          { op: ">=", v: base },
          { op: "<", v: zero({ major: maj + 1 }) },
        ];
      }
      if (patch === null) {
        return [
          { op: ">=", v: base },
          { op: "<", v: zero({ major: maj, minor: minor + 1 }) },
        ];
      }
      return [{ op: "=", v: base }];
    }
  }
}

function satisfiesComparator(v: SemVer, c: Comparator): boolean {
  const cmp = compareSemver(v, c.v);
  switch (c.op) {
    case "=":
      return cmp === 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
  }
}

export function satisfiesRange(version: string, range: string): boolean | null {
  const v = parseSemver(version);
  if (!v) return null;
  // normalize ">= 18" / "^ 4.2" style spacing (common in real engines fields),
  // while preserving hyphen-range separators
  const normalized = range.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1");
  const orParts = normalized.split("||");
  let sawValid = false;
  for (const orPart of orParts) {
    let comparators: Comparator[] = [];
    let valid = true;
    const hyphen = orPart.split(/\s+-\s+/);
    if (hyphen.length === 2 && hyphen[0] && hyphen[1]) {
      const lo = expandPart(">=" + hyphen[0].trim());
      const hi = expandPart("<=" + hyphen[1].trim());
      if (!lo || !hi) valid = false;
      else comparators = [...lo, ...hi];
    } else {
      for (const token of orPart.trim().split(/\s+/)) {
        if (token === "") continue;
        const cs = expandPart(token);
        if (cs === null) {
          valid = false;
          break;
        }
        comparators.push(...cs);
      }
    }
    if (!valid) continue;
    sawValid = true;
    if (comparators.every((c) => satisfiesComparator(v, c))) return true;
  }
  return sawValid ? false : null;
}
