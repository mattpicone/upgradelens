#!/usr/bin/env node
// Offline enrichment job (runs in GitHub Actions, free).
// Fetches GitHub release notes for curated popular packages, extracts
// breaking-change FACTS with deterministic patterns (no LLM), and pushes them
// to the worker's admin ingestion endpoint.
//
// Env: SERVICE_URL, ADMIN_KEY, GITHUB_TOKEN (optional but recommended).
// Release-note text is treated as untrusted data: we extract short factual
// lines and never execute or interpret it.

const SERVICE_URL = process.env.SERVICE_URL;
const ADMIN_KEY = process.env.ADMIN_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!SERVICE_URL || !ADMIN_KEY) {
  console.error("SERVICE_URL and ADMIN_KEY are required.");
  process.exit(1);
}

// Curated high-traffic packages with their GitHub repos.
const TARGETS = [
  { ecosystem: "npm", package: "express", repo: "expressjs/express" },
  { ecosystem: "npm", package: "react", repo: "facebook/react" },
  { ecosystem: "npm", package: "next", repo: "vercel/next.js" },
  { ecosystem: "npm", package: "vue", repo: "vuejs/core" },
  { ecosystem: "npm", package: "typescript", repo: "microsoft/TypeScript" },
  { ecosystem: "npm", package: "eslint", repo: "eslint/eslint" },
  { ecosystem: "npm", package: "vite", repo: "vitejs/vite" },
  { ecosystem: "npm", package: "axios", repo: "axios/axios" },
  { ecosystem: "npm", package: "jest", repo: "jestjs/jest" },
  { ecosystem: "npm", package: "webpack", repo: "webpack/webpack" },
  { ecosystem: "npm", package: "tailwindcss", repo: "tailwindlabs/tailwindcss" },
  { ecosystem: "npm", package: "zod", repo: "colinhacks/zod" },
  { ecosystem: "pypi", package: "django", repo: "django/django" },
  { ecosystem: "pypi", package: "fastapi", repo: "fastapi/fastapi" },
  { ecosystem: "pypi", package: "flask", repo: "pallets/flask" },
  { ecosystem: "pypi", package: "requests", repo: "psf/requests" },
  { ecosystem: "pypi", package: "pydantic", repo: "pydantic/pydantic" },
  { ecosystem: "pypi", package: "sqlalchemy", repo: "sqlalchemy/sqlalchemy" },
  { ecosystem: "pypi", package: "numpy", repo: "numpy/numpy" },
  { ecosystem: "pypi", package: "pandas", repo: "pandas-dev/pandas" },
  { ecosystem: "pypi", package: "httpx", repo: "encode/httpx" },
  { ecosystem: "pypi", package: "celery", repo: "celery/celery" },
];

const BREAKING_HEADING = /^#+\s*.*(breaking|incompatible|removed|migration)/i;
const BREAKING_INLINE = /\bBREAKING(\s+CHANGE)?S?\b[:\s]/i;

function versionFromTag(tag) {
  const m = /v?(\d+[.\w!+-]*)/.exec(tag);
  return m ? m[1] : null;
}

// Deterministic extraction: bullets under breaking headings + explicit
// "BREAKING CHANGE:" lines. Short facts only — never full documents.
function extractBreaking(body) {
  const facts = [];
  const lines = (body ?? "").split(/\r?\n/).slice(0, 800);
  let inBreakingSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#+\s/.test(trimmed)) {
      inBreakingSection = BREAKING_HEADING.test(trimmed);
      continue;
    }
    const isBullet = /^[-*+]\s+/.test(trimmed);
    if (inBreakingSection && isBullet) {
      facts.push({ text: trimmed.replace(/^[-*+]\s+/, ""), confidence: 0.9 });
    } else if (BREAKING_INLINE.test(trimmed) && trimmed.length < 400) {
      facts.push({ text: trimmed, confidence: 0.85 });
    }
    if (facts.length >= 10) break;
  }
  // strip markdown links/images down to their text; drop html
  return facts
    .map((f) => ({
      ...f,
      text: f.text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 280),
    }))
    .filter((f) => f.text.length > 12);
}

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "upgradelens-ci",
      ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  });
  if (!res.ok) return null;
  return res.json();
}

const rows = [];
for (const t of TARGETS) {
  const releases = await gh(`/repos/${t.repo}/releases?per_page=15`);
  if (!Array.isArray(releases)) {
    console.warn(`skip ${t.repo}: releases unavailable`);
    continue;
  }
  for (const rel of releases) {
    const version = versionFromTag(rel.tag_name ?? "");
    if (!version || rel.draft) continue;
    for (const fact of extractBreaking(rel.body)) {
      rows.push({
        ecosystem: t.ecosystem,
        package: t.package,
        version,
        summary: fact.text,
        severity: "high",
        source_url: rel.html_url,
        confidence: fact.confidence,
      });
    }
  }
  console.log(`${t.repo}: cumulative facts=${rows.length}`);
}

console.log(`Extracted ${rows.length} breaking-change facts. Ingesting...`);
for (let i = 0; i < rows.length; i += 200) {
  const chunk = rows.slice(i, i + 200);
  const res = await fetch(`${SERVICE_URL}/admin/breaking-changes`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-key": ADMIN_KEY,
      "user-agent": "upgradelens-ci",
    },
    body: JSON.stringify({ rows: chunk }),
  });
  console.log(`chunk ${i / 200}: ${res.status} ${await res.text()}`);
  if (!res.ok) process.exit(1);
}

// mark enrichment freshness
await fetch(`${SERVICE_URL}/admin/refresh-source-snapshot`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY, "user-agent": "upgradelens-ci" },
  body: JSON.stringify({ source: "github_enrichment" }),
});
console.log("Done.");
