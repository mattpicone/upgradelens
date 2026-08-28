// endoflife.date API — product lifecycle/EOL data (free, no auth).
// Only consulted for packages that map to a known endoflife.date product.

import { fetchJson, type SourceResult } from "./fetch";
import type { Ecosystem } from "../types";

// Conservative curated map: registry package -> endoflife.date product slug.
const EOL_PRODUCTS: Record<Ecosystem, Record<string, string>> = {
  npm: {
    react: "react",
    angular: "angular",
    "@angular/core": "angular",
    vue: "vue",
    next: "nextjs",
    nuxt: "nuxt",
    express: "express",
    electron: "electron",
    jquery: "jquery",
    bootstrap: "bootstrap",
    typescript: "typescript",
    eslint: "eslint",
  },
  pypi: {
    django: "django",
    flask: "flask",
    numpy: "numpy",
    pandas: "pandas",
    ansible: "ansible",
    sqlalchemy: "sqlalchemy",
    "scikit-learn": "scikit-learn",
  },
};

export interface EolCycle {
  cycle: string;
  eol: string | boolean;
  support?: string | boolean;
  latest?: string;
}

export interface EolInfo {
  product: string;
  cycles: EolCycle[];
  source_url: string;
  fetched_at: string;
}

export function eolProductFor(ecosystem: Ecosystem, pkg: string): string | null {
  return EOL_PRODUCTS[ecosystem][pkg.toLowerCase()] ?? null;
}

export async function fetchEol(product: string): Promise<SourceResult<EolInfo>> {
  const url = `https://endoflife.date/api/${encodeURIComponent(product)}.json`;
  const res = await fetchJson<EolCycle[]>(url, { timeoutMs: 6000 });
  if (!res.ok || !res.data) return { ...res, data: null };
  return {
    ...res,
    data: { product, cycles: res.data, source_url: url, fetched_at: res.fetched_at },
  };
}

// Determine EOL status of the major-version cycle a version belongs to.
export function cycleStatus(
  cycles: EolCycle[],
  version: string,
): { cycle: string; eol: boolean | null; eol_date: string | null } | null {
  const major = version.split(".")[0];
  if (!major) return null;
  const matched =
    cycles.find((c) => c.cycle === major) ??
    cycles.find((c) => version.startsWith(c.cycle + "."));
  if (!matched) return null;
  if (typeof matched.eol === "boolean") {
    return { cycle: matched.cycle, eol: matched.eol, eol_date: null };
  }
  const eolDate = new Date(matched.eol);
  return {
    cycle: matched.cycle,
    eol: isNaN(eolDate.getTime()) ? null : eolDate.getTime() < Date.now(),
    eol_date: matched.eol,
  };
}
