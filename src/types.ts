export interface Env {
  DB: D1Database;
  ANALYSIS_VERSION: string;
  SERVICE_VERSION: string;
  PAYMENTS_ENABLED: string;
  PAYMENT_MODE?: "validation" | "testnet" | "mainnet" | "paused";
  MCP_TESTNET_TOKEN?: string;
  PUBLIC_BASE_URL: string;
  X402_PAY_TO?: string;
  TRIAL_HMAC_SECRET?: string;
  PAYMENT_RECOVERY_SECRET?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  CDP_FACILITATOR_URL?: string;
  /** Conservative known facilitator/settlement cost per analysis, in USD micros. */
  KNOWN_UNIT_COST_MICROS?: string;
  /** Release fingerprints copied from the attested build before mainnet. */
  RELEASE_GIT_SHA?: string;
  RELEASE_LOCKFILE_HASH?: string;
  RELEASE_SUITE_HASH?: string;
  BAZAAR_STATE?:
    | "absent"
    | "testnet_indexed"
    | "production_awaiting_first_settlement"
    | "production_indexed"
    | "curated";
  ANON_RATE_LIMITER?: RateLimit;
  KEY_RATE_LIMITER?: RateLimit;
  OWNER_TOKEN?: string;
  ADMIN_KEY?: string;
}

export type Ecosystem = "npm" | "pypi";

export type Decision = "proceed" | "review_required" | "block" | "unknown";

export interface BillingMetadata {
  mode: "validation" | "testnet" | "mainnet" | "paused";
  units: number;
  price_usd: number;
  trial_remaining: number | null;
  network: string | null;
  payment_status:
    | "validation_free"
    | "trial"
    | "settled"
    | "cached_settlement"
    | "owner"
    | "unavailable";
}

export interface MachineResultFields {
  next_action: string;
  recommended_target?: string | null;
  billing: BillingMetadata;
}

export type CoverageStatus =
  | "complete"
  | "partial"
  | "unavailable"
  | "not_applicable"
  | "not_covered";

export interface SourceCoverage {
  status: CoverageStatus;
  as_of: string | null;
  detail?: string;
}

export interface AnalysisCoverage {
  registry: SourceCoverage;
  osv: SourceCoverage;
  deps_dev: SourceCoverage;
  eol: SourceCoverage;
  breaking_changes: SourceCoverage;
}

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
  action_allowed: boolean;
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
  claim_evidence: { claim: string; evidence_ids: string[] }[];
  evidence: Evidence[];
  coverage: AnalysisCoverage;
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
  requires_full_check: boolean;
}

export interface FindTargetResult {
  /** Candidate discovery never authorizes an edit; a follow-up check/plan is required. */
  action_allowed: boolean;
  ecosystem: Ecosystem;
  package: string;
  current_version: string;
  latest_stable: string | null;
  candidates: TargetCandidate[];
  evidence: Evidence[];
  coverage: Pick<AnalysisCoverage, "deps_dev" | "osv">;
  confidence: number;
  freshness: string;
  analysis_version: string;
}
