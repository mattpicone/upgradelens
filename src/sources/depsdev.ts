// deps.dev v3 API — compact version listing with publish dates (free, no auth).

import { fetchJson, type SourceResult } from "./fetch";
import type { Ecosystem } from "../types";

const DEPSDEV_SYSTEM: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "pypi",
};

export interface PackageVersions {
  name: string;
  versions: { version: string; published_at: string | null; is_default: boolean }[];
  default_version: string | null;
  source_url: string;
  fetched_at: string;
}

interface DepsDevPackageResponse {
  packageKey?: { name?: string };
  versions?: {
    versionKey?: { version?: string };
    publishedAt?: string;
    isDefault?: boolean;
  }[];
}

export async function fetchPackageVersions(
  ecosystem: Ecosystem,
  pkg: string,
): Promise<SourceResult<PackageVersions>> {
  const sys = DEPSDEV_SYSTEM[ecosystem];
  const url = `https://api.deps.dev/v3/systems/${sys}/packages/${encodeURIComponent(pkg)}`;
  const res = await fetchJson<DepsDevPackageResponse>(url, { timeoutMs: 8000 });
  if (!res.ok || !res.data) return { ...res, data: null };
  const versions = (res.data.versions ?? []).map((v) => ({
    version: v.versionKey?.version ?? "",
    published_at: v.publishedAt ?? null,
    is_default: v.isDefault ?? false,
  }));
  return {
    ...res,
    data: {
      name: res.data.packageKey?.name ?? pkg,
      versions,
      default_version: versions.find((v) => v.is_default)?.version ?? null,
      source_url: url,
      fetched_at: res.fetched_at,
    },
  };
}
