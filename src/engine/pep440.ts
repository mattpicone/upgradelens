// Compact PEP 440 version handling: parse, compare, jump classification, and
// specifier-set satisfaction for `requires_python`-style expressions.

export interface Pep440 {
  epoch: number;
  release: number[];
  preKind: string | null; // a | b | rc
  preNum: number;
  post: number | null;
  dev: number | null;
  raw: string;
}

const PEP440_RE =
  /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[._-]?(a|b|c|rc|alpha|beta|pre|preview)[._-]?(\d*))?(?:[._-]?(?:post|rev|r)[._-]?(\d*))?(?:[._-]?dev[._-]?(\d*))?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i;

const PRE_NORMALIZE: Record<string, string> = {
  a: "a",
  alpha: "a",
  b: "b",
  beta: "b",
  c: "rc",
  rc: "rc",
  pre: "rc",
  preview: "rc",
};

export function parsePep440(input: string): Pep440 | null {
  const m = PEP440_RE.exec(input.trim());
  if (!m) return null;
  return {
    epoch: m[1] ? Number(m[1]) : 0,
    release: (m[2] ?? "0").split(".").map(Number),
    preKind: m[3] ? (PRE_NORMALIZE[m[3].toLowerCase()] ?? "rc") : null,
    preNum: m[4] ? Number(m[4] || 0) : 0,
    post: m[5] !== undefined ? Number(m[5] || 0) : null,
    dev: m[6] !== undefined ? Number(m[6] || 0) : null,
    raw: input.trim(),
  };
}

function cmpRelease(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

const PRE_ORDER: Record<string, number> = { a: 0, b: 1, rc: 2 };

export function comparePep440(a: Pep440, b: Pep440): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const rc = cmpRelease(a.release, b.release);
  if (rc !== 0) return rc;
  // dev < pre < final < post
  const rank = (v: Pep440): number =>
    v.dev !== null && v.preKind === null && v.post === null
      ? 0
      : v.preKind !== null
        ? 1
        : v.post !== null
          ? 3
          : 2;
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 1) {
    const pa = PRE_ORDER[a.preKind as string] ?? 0;
    const pb = PRE_ORDER[b.preKind as string] ?? 0;
    if (pa !== pb) return pa - pb;
    if (a.preNum !== b.preNum) return a.preNum - b.preNum;
  }
  if (ra === 3 && a.post !== b.post) return (a.post ?? 0) - (b.post ?? 0);
  const da = a.dev ?? Infinity;
  const db = b.dev ?? Infinity;
  if (da !== db) return da === Infinity ? 1 : db === Infinity ? -1 : da - db;
  return 0;
}

export function compareVersionsPy(a: string, b: string): number | null {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (!pa || !pb) return null;
  return comparePep440(pa, pb);
}

export function isPrereleasePy(v: string): boolean {
  const p = parsePep440(v);
  return p ? p.preKind !== null || p.dev !== null : false;
}

export type JumpPy = "major" | "minor" | "patch" | "prerelease" | "none" | "unknown";

export function classifyJumpPy(from: string, to: string): JumpPy {
  const a = parsePep440(from);
  const b = parsePep440(to);
  if (!a || !b) return "unknown";
  if (comparePep440(a, b) === 0) return "none";
  if ((a.release[0] ?? 0) !== (b.release[0] ?? 0)) return "major";
  if ((a.release[1] ?? 0) !== (b.release[1] ?? 0)) return "minor";
  if ((a.release[2] ?? 0) !== (b.release[2] ?? 0)) return "patch";
  return "prerelease";
}

// --- requires_python specifier sets ----------------------------------------
// e.g. ">=3.9", ">=3.8,<4", "!=3.0.*", "~=3.10"

export function satisfiesPySpec(version: string, spec: string): boolean | null {
  const v = parsePep440(version);
  if (!v) return null;
  let sawValid = false;
  for (const rawClause of spec.split(",")) {
    const clause = rawClause.trim();
    if (clause === "") continue;
    const m = /^(~=|==|!=|>=|<=|>|<|===)\s*v?([\w.*!+-]+)$/.exec(clause);
    if (!m) continue;
    const op = m[1] as string;
    let target = m[2] as string;
    const wildcard = target.endsWith(".*");
    if (wildcard) target = target.slice(0, -2);
    const t = parsePep440(target);
    if (!t) continue;
    sawValid = true;
    const cmp = comparePep440(v, t);
    const prefixMatch = (): boolean => {
      const n = t.release.length;
      return (
        v.epoch === t.epoch && cmpRelease(v.release.slice(0, n), t.release) === 0
      );
    };
    let ok: boolean;
    switch (op) {
      case "==":
      case "===":
        ok = wildcard ? prefixMatch() : cmp === 0;
        break;
      case "!=":
        ok = wildcard ? !prefixMatch() : cmp !== 0;
        break;
      case ">=":
        ok = cmp >= 0;
        break;
      case "<=":
        ok = cmp <= 0;
        break;
      case ">":
        ok = cmp > 0;
        break;
      case "<":
        ok = cmp < 0;
        break;
      case "~=": {
        const lower = cmp >= 0;
        const upperRelease = t.release.slice(0, -1);
        if (upperRelease.length === 0) return null;
        upperRelease[upperRelease.length - 1] =
          (upperRelease[upperRelease.length - 1] ?? 0) + 1;
        const upper: Pep440 = {
          epoch: t.epoch,
          release: upperRelease,
          preKind: null,
          preNum: 0,
          post: null,
          dev: null,
          raw: "",
        };
        ok = lower && comparePep440(v, upper) < 0;
        break;
      }
      default:
        ok = true;
    }
    if (!ok) return false;
  }
  return sawValid ? true : null;
}
