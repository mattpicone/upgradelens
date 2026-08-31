# UpgradeLens v0.3 operating charter

UpgradeLens is a machine-only, read-only dependency-upgrade intelligence
service for npm and PyPI. Its immutable machine contract is **0.3.1**. The
service never executes caller commands, clones repositories, follows
caller-supplied URLs, or edits a caller's dependency files.

Current deployment is the existing Cloudflare Worker at
`https://upgradelens.mattpicone.workers.dev` (`/mcp` and `/v1/*`). Start local
work with `npm ci`; use `npm run dev` for a Worker preview or
`npm run build` for a Cloudflare bundle check.

## Contract

- `check_dependency_upgrade`: known current and target versions; returns a
  cited proceed/review/block/unknown decision.
- `find_safe_upgrade_target`: target unknown; returns ranked candidates only.
- `plan_dependency_upgrade`: target selected; returns ordered migration actions.
- Every business result has `next_action`, `billing`, `decision` or candidates,
  `action_allowed`, freshness, coverage, and evidence near the top.
- Errors use `{error:{code,message,retryable,details?}}`.
- The only supported ecosystems are npm and PyPI.

## Access and payment

Health, discovery, schemas, pricing, `initialize`, and `tools/list` are free.
Each pseudonymous normalized-network identity receives one shared MCP/REST
business unit per rolling 30 days. A unit is exactly $0.01 / 10,000 atomic
USDC. Additional units use x402 v2; there are no subscriptions, prepaid
credits, checkout pages, API-key sales, or human approvals. Existing legacy
keys are compatibility identifiers only and never bypass payment.

Validation, testnet, mainnet, and paused are explicit payment modes. Mainnet
must fail closed unless a verified recipient, facilitator credentials, recovery
secret, release fingerprints, and matching testnet rollout attestation exist. Only a verified, settled,
eligible Base-mainnet payment counts as revenue. Testnet, owner, duplicate,
replayed, failed, refunded, or synthetic activity counts as zero revenue.

## Operator workflow

Run `npm run typecheck`, `npm run contract:check`, `npm test`, and
`npm run operator:status` before a release. Apply migrations in order,
including `0006_machine_payments.sql`.
Use `npm run buyer:harness` for unseeded discovery checks and
`npm run payment:probe` for a no-payment challenge probe. These probes must
never use a real merchant sale or inflate business counters.

Completion requires passing typecheck, the full suite, the Cloudflare bundle
check, public `/healthz`/OpenAPI/pricing consistency, and exact Registry
version verification. A testnet settlement, Bazaar indexing, and a mainnet
attestation remain external gates and must be reported as pending until
observed.

Do not enable mainnet or publish a success claim without real external
credentials, a recoverable recipient, and an observed testnet settlement. The
remaining owner-only gate must be reported honestly rather than replaced with
placeholder data.
