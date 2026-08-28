// PEP 440 version ordering and specifier-set evaluation. Numeric components are
// retained as strings internally so registry versions cannot lose precision in
// JavaScript's Number representation.

export interface Pep440 {
  epoch: number;
  release: number[];
  preKind: "a" | "b" | "rc" | null;
  preNum: number;
  post: number | null;
  dev: number | null;
  local: (string | number)[] | null;
  raw: string;
  epochRaw: string;
  releaseRaw: string[];
  preNumRaw: string;
  postRaw: string | null;
  devRaw: string | null;
  localRaw: { numeric: boolean; value: string }[] | null;
}

const VERSION_RE = /^\s*v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:(?:-(\d+))|(?:[-_.]?(post|rev|r)[-_.]?(\d*)))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?\s*$/i;

const PRE_NORMALIZE: Record<string, "a" | "b" | "rc"> = {
  a: "a",
  alpha: "a",
  b: "b",
  beta: "b",
  c: "rc",
  rc: "rc",
  pre: "rc",
  preview: "rc",
};

function normInt(value: string | undefined, fallback = "0"): string {
  const raw = value === undefined || value === "" ? fallback : value;
  return raw.replace(/^0+(?=\d)/, "") || "0";
}

function cmpInt(a: string, b: string): number {
  const aa = normInt(a);
  const bb = normInt(b);
  if (aa.length !== bb.length) return aa.length < bb.length ? -1 : 1;
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}

function cmpRelease(a: string[], b: string[]): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const cmp = cmpInt(a[i] ?? "0", b[i] ?? "0");
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function parsePep440(input: string): Pep440 | null {
  const m = VERSION_RE.exec(input);
  if (!m) return null;
  const epochRaw = normInt(m[1]);
  const releaseRaw = m[2]!.split(".").map((x) => normInt(x));
  const preKind = m[3] ? (PRE_NORMALIZE[m[3].toLowerCase()] ?? "rc") : null;
  const preNumRaw = normInt(m[4]);
  const postRaw = m[5] !== undefined
    ? normInt(m[5])
    : m[6] !== undefined
      ? normInt(m[7])
      : null;
  const devRaw = m[8] !== undefined ? normInt(m[8]) : null;
  const localRaw = m[9]
    ? m[9].toLowerCase().split(/[-_.]/).map((part) => ({
        numeric: /^\d+$/.test(part),
        value: /^\d+$/.test(part) ? normInt(part) : part,
      }))
    : null;
  return {
    epoch: Number(epochRaw),
    release: releaseRaw.map(Number),
    preKind,
    preNum: Number(preNumRaw),
    post: postRaw === null ? null : Number(postRaw),
    dev: devRaw === null ? null : Number(devRaw),
    local: localRaw?.map((part) => part.numeric ? Number(part.value) : part.value) ?? null,
    raw: input.trim(),
    epochRaw,
    releaseRaw,
    preNumRaw,
    postRaw,
    devRaw,
    localRaw,
  };
}

function cmpPre(a: Pep440, b: Pep440): number {
  const key = (v: Pep440): { sentinel: -1 | 0 | 1; kind?: number; num?: string } => {
    if (v.preKind === null && v.postRaw === null && v.devRaw !== null) return { sentinel: -1 };
    if (v.preKind === null) return { sentinel: 1 };
    return { sentinel: 0, kind: { a: 0, b: 1, rc: 2 }[v.preKind], num: v.preNumRaw };
  };
  const aa = key(a);
  const bb = key(b);
  if (aa.sentinel !== bb.sentinel) return aa.sentinel < bb.sentinel ? -1 : 1;
  if (aa.sentinel !== 0) return 0;
  if (aa.kind !== bb.kind) return (aa.kind ?? 0) < (bb.kind ?? 0) ? -1 : 1;
  return cmpInt(aa.num ?? "0", bb.num ?? "0");
}

function cmpOptionalInt(a: string | null, b: string | null, nullHigh: boolean): number {
  if (a === null && b === null) return 0;
  if (a === null) return nullHigh ? 1 : -1;
  if (b === null) return nullHigh ? -1 : 1;
  return cmpInt(a, b);
}

function cmpLocal(a: Pep440["localRaw"], b: Pep440["localRaw"]): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const aa = a[i];
    const bb = b[i];
    if (!aa) return -1;
    if (!bb) return 1;
    if (aa.numeric !== bb.numeric) return aa.numeric ? 1 : -1;
    const cmp = aa.numeric
      ? cmpInt(aa.value, bb.value)
      : aa.value < bb.value ? -1 : aa.value > bb.value ? 1 : 0;
    if (cmp !== 0) return cmp;
  }
  return 0;
}

function comparePublic(a: Pep440, b: Pep440): number {
  let cmp = cmpInt(a.epochRaw, b.epochRaw);
  if (cmp !== 0) return cmp;
  cmp = cmpRelease(a.releaseRaw, b.releaseRaw);
  if (cmp !== 0) return cmp;
  cmp = cmpPre(a, b);
  if (cmp !== 0) return cmp;
  cmp = cmpOptionalInt(a.postRaw, b.postRaw, false);
  if (cmp !== 0) return cmp;
  return cmpOptionalInt(a.devRaw, b.devRaw, true);
}

export function comparePep440(a: Pep440, b: Pep440): number {
  const publicCmp = comparePublic(a, b);
  return publicCmp !== 0 ? publicCmp : cmpLocal(a.localRaw, b.localRaw);
}

export function compareVersionsPy(a: string, b: string): number | null {
  const pa = parsePep440(a);
  const pb = parsePep440(b);
  if (!pa || !pb) return null;
  return comparePep440(pa, pb);
}

export function isPrereleasePy(v: string): boolean {
  const parsed = parsePep440(v);
  return parsed ? parsed.preKind !== null || parsed.devRaw !== null : false;
}

export type JumpPy = "major" | "minor" | "patch" | "prerelease" | "none" | "unknown";

export function classifyJumpPy(from: string, to: string): JumpPy {
  const a = parsePep440(from);
  const b = parsePep440(to);
  if (!a || !b) return "unknown";
  if (comparePep440(a, b) === 0) return "none";
  if (cmpInt(a.epochRaw, b.epochRaw) !== 0 || cmpInt(a.releaseRaw[0] ?? "0", b.releaseRaw[0] ?? "0") !== 0) return "major";
  if (cmpInt(a.releaseRaw[1] ?? "0", b.releaseRaw[1] ?? "0") !== 0) return "minor";
  if (cmpInt(a.releaseRaw[2] ?? "0", b.releaseRaw[2] ?? "0") !== 0) return "patch";
  return "prerelease";
}

interface Clause {
  op: "~=" | "==" | "!=" | ">=" | "<=" | ">" | "<" | "===";
  rawTarget: string;
  target: Pep440 | null;
  wildcard: boolean;
}

function parseClauses(spec: string): Clause[] | null {
  const rawClauses = spec.split(",").map((x) => x.trim()).filter(Boolean);
  if (rawClauses.length === 0) return null;
  const clauses: Clause[] = [];
  for (const raw of rawClauses) {
    const match = /^(===|~=|==|!=|>=|<=|>|<)\s*(\S+)$/.exec(raw);
    if (!match) return null;
    const op = match[1] as Clause["op"];
    const rawTarget = match[2]!;
    if (op === "===") {
      clauses.push({ op, rawTarget, target: null, wildcard: false });
      continue;
    }
    const wildcard = rawTarget.endsWith(".*");
    if (wildcard && op !== "==" && op !== "!=") return null;
    const targetText = wildcard ? rawTarget.slice(0, -2) : rawTarget;
    const target = parsePep440(targetText);
    if (!target) return null;
    if (target.localRaw !== null && op !== "==" && op !== "!=") return null;
    if (op === "~=" && target.releaseRaw.length < 2) return null;
    clauses.push({ op, rawTarget, target, wildcard });
  }
  return clauses;
}

function sameRelease(a: Pep440, b: Pep440): boolean {
  return cmpInt(a.epochRaw, b.epochRaw) === 0 && cmpRelease(a.releaseRaw, b.releaseRaw) === 0;
}

function prefixMatch(version: Pep440, target: Pep440): boolean {
  if (cmpInt(version.epochRaw, target.epochRaw) !== 0) return false;
  return target.releaseRaw.every((part, index) => cmpInt(version.releaseRaw[index] ?? "0", part) === 0);
}

export function satisfiesPySpec(version: string, spec: string): boolean | null {
  const parsed = parsePep440(version);
  const clauses = parseClauses(spec);
  if (!parsed || !clauses) return null;

  const prereleasesAllowed = clauses.some((clause) =>
    clause.op === "===" || clause.target?.preKind !== null || clause.target?.devRaw !== null
  );
  if ((parsed.preKind !== null || parsed.devRaw !== null) && !prereleasesAllowed) return false;

  for (const clause of clauses) {
    if (clause.op === "===") {
      if (parsed.raw.toLowerCase() !== clause.rawTarget.toLowerCase()) return false;
      continue;
    }
    const target = clause.target!;
    const publicCmp = comparePublic(parsed, target);
    let ok = false;
    switch (clause.op) {
      case "==":
        ok = clause.wildcard
          ? prefixMatch(parsed, target)
          : target.localRaw === null ? publicCmp === 0 : comparePep440(parsed, target) === 0;
        break;
      case "!=":
        ok = clause.wildcard
          ? !prefixMatch(parsed, target)
          : target.localRaw === null ? publicCmp !== 0 : comparePep440(parsed, target) !== 0;
        break;
      case ">=":
        ok = publicCmp >= 0;
        break;
      case "<=":
        ok = publicCmp <= 0;
        break;
      case "<":
        ok = publicCmp < 0 && !(sameRelease(parsed, target) && parsed.preKind !== null && target.preKind === null);
        break;
      case ">":
        ok = publicCmp > 0 && !(sameRelease(parsed, target) && parsed.postRaw !== null && target.postRaw === null);
        break;
      case "~=": {
        const prefix = target.releaseRaw.slice(0, -1);
        const upperRelease = [...prefix];
        upperRelease[upperRelease.length - 1] = (BigInt(upperRelease.at(-1) ?? "0") + 1n).toString();
        const upper = parsePep440(`${target.epochRaw === "0" ? "" : `${target.epochRaw}!`}${upperRelease.join(".")}`)!;
        ok = publicCmp >= 0 && comparePublic(parsed, upper) < 0;
        break;
      }
    }
    if (!ok) return false;
  }
  return true;
}
