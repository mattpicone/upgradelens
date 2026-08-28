export interface Env {
  DB: D1Database;
  ANALYSIS_VERSION: string;
  SERVICE_VERSION: string;
  PAYMENTS_ENABLED: string;
  PUBLIC_BASE_URL: string;
  OWNER_TOKEN?: string;
  ADMIN_KEY?: string;
}

export type Ecosystem = "npm" | "pypi";

export type Decision = "proceed" | "review_required" | "block" | "unknown";

export interface Evidence {
  id: string;
  source_type:
    | "registry"
    | "osv"
    | "deps_dev"
    | "endoflife"
    | "github_release"
    | "changelog"
    | "heuristic";
  source_url: string;
  fact: string;
  confidence: number;
  fetched_at: string;
}

export interface AdvisorySummary {
  id: string;
  aliases: string[];
  summary: string;
  severity: string | null;
  url: string;
}

export interface UpgradeCheckRequest {
  ecosystem: Ecosystem;
  package: string;
  current_version: string;
  target_version: string;
  runtime?: {
    node?: string;
    python?: string;
  };
}

export interface UpgradeCheckResult {
  decision: Decision;
  risk_score: number;
  ecosystem: Ecosystem;
  package: string;
  current_version: string;
  target_version: string;
  latest_stable: string | null;
  repository_url: string | null;
  version_facts: {
    current_published_at: string | null;
    target_published_at: string | null;
    current_yanked: boolean;
    target_yanked: boolean;
    package_deprecated: boolean;
    target_deprecation_message: string | null;
    is_downgrade: boolean;
    semver_jump: "major" | "minor" | "patch" | "prerelease" | "none" | "unknown";
    versions_between: number | null;
  };
  security_delta: {
    advisories_affecting_current: AdvisorySummary[];
    advisories_fixed_by_target: AdvisorySummary[];
    advisories_affecting_target: AdvisorySummary[];
  };
  compatibility: {
    runtime_supported: boolean | null;
    runtime_notes: string[];
    dependency_changes: {
      added: string[];
      removed: string[];
      changed: { name: string; from: string; to: string }[];
    } | null;
    license_change: { from: string | null; to: string | null } | null;
  };
  breaking_changes: {
    summary: string;
    severity: string;
    confidence: number;
    source_url: string;
  }[];
  reasons: string[];
  evidence: Evidence[];
  confidence: number;
  freshness: string;
  analysis_version: string;
  cache_hit?: boolean;
}

export interface MigrationAction {
  order: number;
  action: string;
  evidence_ids: string[];
}

export interface UpgradePlanResult extends UpgradeCheckResult {
  migration_actions: MigrationAction[];
  changelog_urls: string[];
}

export interface TargetCandidate {
  version: string;
  score: number;
  decision: Decision;
  rationale: string[];
  fixes_advisories: string[];
  introduces_advisories: string[];
  semver_jump: string;
  published_at: string | null;
}

export interface FindTargetResult {
  ecosystem: Ecosystem;
  package: string;
  current_version: string;
  latest_stable: string | null;
  candidates: TargetCandidate[];
  evidence: Evidence[];
  confidence: number;
  freshness: string;
  analysis_version: string;
}
