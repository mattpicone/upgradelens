// OSV.dev vulnerability queries (free, no auth, no advertised rate limit).

import { fetchJson, type SourceResult } from "./fetch";
import type { AdvisorySummary, Ecosystem } from "../types";

const OSV_ECOSYSTEM: Record<Ecosystem, string> = {
  npm: "npm",
  pypi: "PyPI",
};

interface OsvVuln {
  id: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string };
}

interface OsvQueryResponse {
  vulns?: OsvVuln[];
}

function severityOf(v: OsvVuln): string | null {
  if (v.database_specific?.severity) return v.database_specific.severity.toLowerCase();
  const cvss = v.severity?.find((s) => s.type.startsWith("CVSS"));
  if (cvss) return `cvss:${cvss.score}`;
  return null;
}

export function normalizeVuln(v: OsvVuln): AdvisorySummary {
  return {
    id: v.id,
    aliases: v.aliases ?? [],
    summary: (v.summary ?? v.details ?? "").slice(0, 300),
    severity: severityOf(v),
    url: `https://osv.dev/vulnerability/${v.id}`,
  };
}

export async function queryOsv(
  ecosystem: Ecosystem,
  pkg: string,
  version: string,
): Promise<SourceResult<AdvisorySummary[]>> {
  const url = "https://api.osv.dev/v1/query";
  const res = await fetchJson<OsvQueryResponse>(url, {
    method: "POST",
    body: JSON.stringify({
      package: { name: pkg, ecosystem: OSV_ECOSYSTEM[ecosystem] },
      version,
    }),
    headers: { "content-type": "application/json" },
    timeoutMs: 8000,
  });
  if (!res.ok) return { ...res, data: null };
  return { ...res, data: (res.data?.vulns ?? []).map(normalizeVuln) };
}

// Batched query for two versions in one upstream round trip.
export async function queryOsvPair(
  ecosystem: Ecosystem,
  pkg: string,
  currentVersion: string,
  targetVersion: string,
): Promise<{
  current: SourceResult<AdvisorySummary[]>;
  target: SourceResult<AdvisorySummary[]>;
}> {
  const url = "https://api.osv.dev/v1/querybatch";
  const res = await fetchJson<{ results: { vulns?: { id: string }[] }[] }>(url, {
    method: "POST",
    body: JSON.stringify({
      queries: [
        { package: { name: pkg, ecosystem: OSV_ECOSYSTEM[ecosystem] }, version: currentVersion },
        { package: { name: pkg, ecosystem: OSV_ECOSYSTEM[ecosystem] }, version: targetVersion },
      ],
    }),
    headers: { "content-type": "application/json" },
    timeoutMs: 8000,
  });
  // querybatch returns only IDs. For summaries we still make full queries, but
  // only when the batch says vulnerabilities exist — the common case (no vulns)
  // costs exactly one subrequest.
  if (!res.ok || !res.data) {
    const fail = { ...res, data: null } as SourceResult<AdvisorySummary[]>;
    return { current: fail, target: fail };
  }
  const [curIds, tgtIds] = [
    res.data.results[0]?.vulns ?? [],
    res.data.results[1]?.vulns ?? [],
  ];
  const empty = (): SourceResult<AdvisorySummary[]> => ({
    ok: true,
    data: [],
    status: 200,
    url,
    fetched_at: res.fetched_at,
  });
  const [current, target] = await Promise.all([
    curIds.length > 0 ? queryOsv(ecosystem, pkg, currentVersion) : Promise.resolve(empty()),
    tgtIds.length > 0 ? queryOsv(ecosystem, pkg, targetVersion) : Promise.resolve(empty()),
  ]);
  return { current, target };
}
