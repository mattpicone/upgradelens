// npm + PyPI registry clients.
// Deliberately uses SMALL per-version endpoints instead of full packuments:
// full packuments for popular packages are multi-megabyte and would exceed
// the Workers free plan 10ms CPU budget just in JSON parsing.

import { fetchJson, type SourceResult } from "./fetch";
import type { Ecosystem } from "../types";

export interface VersionDetail {
  version: string;
  published_at: string | null;
  yanked: boolean;
  // npm: engines.node range; pypi: requires_python spec
  runtime_requirement: string | null;
  dependencies: Record<string, string>;
  license: string | null;
  deprecated_message: string | null;
  repository_url: string | null;
  source_url: string;
  fetched_at: string;
}

function normalizeRepoUrl(repo: { url?: string } | string | undefined | null): string | null {
  const raw = typeof repo === "string" ? repo : repo?.url;
  if (!raw) return null;
  return raw
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "");
}

interface NpmVersionDoc {
  version?: string;
  engines?: Record<string, string>;
  dependencies?: Record<string, string>;
  license?: string | { type?: string };
  deprecated?: string | boolean;
  repository?: { url?: string } | string;
}

function npmUrl(pkg: string, suffix: string): string {
  // scoped packages need the slash within the name encoded as %2F but @ kept
  const enc = pkg.startsWith("@") ? "@" + encodeURIComponent(pkg.slice(1)) : encodeURIComponent(pkg);
  return `https://registry.npmjs.org/${enc}/${suffix}`;
}

async function fetchNpmVersionDetail(
  pkg: string,
  version: string,
): Promise<SourceResult<VersionDetail>> {
  const url = npmUrl(pkg, encodeURIComponent(version));
  const res = await fetchJson<NpmVersionDoc>(url, { timeoutMs: 8000 });
  if (!res.ok || !res.data) return { ...res, data: null };
  const v = res.data;
  return {
    ...res,
    data: {
      version: v.version ?? version,
      published_at: null, // provided by deps.dev package listing
      yanked: false,
      runtime_requirement: v.engines?.node ?? null,
      dependencies: v.dependencies ?? {},
      license: typeof v.license === "string" ? v.license : (v.license?.type ?? null),
      deprecated_message:
        typeof v.deprecated === "string" ? v.deprecated : v.deprecated ? "deprecated" : null,
      repository_url: normalizeRepoUrl(v.repository),
      source_url: url,
      fetched_at: res.fetched_at,
    },
  };
}

interface PypiVersionDoc {
  info?: {
    version?: string;
    requires_python?: string | null;
    requires_dist?: string[] | null;
    license?: string | null;
    yanked?: boolean;
    project_urls?: Record<string, string> | null;
  };
  urls?: { upload_time_iso_8601?: string; yanked?: boolean }[];
}

function pypiRepoUrl(urls: Record<string, string> | null | undefined): string | null {
  if (!urls) return null;
  for (const key of ["repository", "source", "source code", "code", "github", "homepage"]) {
    for (const [k, v] of Object.entries(urls)) {
      if (k.toLowerCase() === key && /github\.com|gitlab\.com/.test(v)) return v;
    }
  }
  for (const v of Object.values(urls)) {
    if (/github\.com|gitlab\.com/.test(v)) return v;
  }
  return null;
}

// Extract bare dependency names from requires_dist entries, skipping extras.
export function parseRequiresDist(requiresDist: string[]): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const entry of requiresDist) {
    if (/extra\s*==/.test(entry)) continue; // optional extras
    const m = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(\(?[^;]*\)?)?/.exec(entry.trim());
    if (m && m[1]) {
      deps[m[1].toLowerCase()] = (m[2] ?? "").replace(/[()]/g, "").trim() || "*";
    }
  }
  return deps;
}

async function fetchPypiVersionDetail(
  pkg: string,
  version: string,
): Promise<SourceResult<VersionDetail>> {
  const url = `https://pypi.org/pypi/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/json`;
  const res = await fetchJson<PypiVersionDoc>(url, { timeoutMs: 8000 });
  if (!res.ok || !res.data) return { ...res, data: null };
  const info = res.data.info ?? {};
  const files = res.data.urls ?? [];
  return {
    ...res,
    data: {
      version: info.version ?? version,
      published_at: files[0]?.upload_time_iso_8601 ?? null,
      yanked: info.yanked ?? (files.length > 0 && files.every((f) => f.yanked === true)),
      runtime_requirement: info.requires_python ?? null,
      dependencies: parseRequiresDist(info.requires_dist ?? []),
      license: (info.license ?? "").slice(0, 120) || null,
      deprecated_message: null,
      repository_url: pypiRepoUrl(info.project_urls),
      source_url: url,
      fetched_at: res.fetched_at,
    },
  };
}

export async function fetchVersionDetail(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): Promise<SourceResult<VersionDetail>> {
  return ecosystem === "npm"
    ? fetchNpmVersionDetail(pkg, version)
    : fetchPypiVersionDetail(pkg, version);
}
