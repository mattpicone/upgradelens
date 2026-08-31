# Security Policy

## Design guarantees

UpgradeLens is a **read-only** intelligence service:

- It never executes package-manager or shell commands, from callers or otherwise.
- It never clones repositories.
- It never fetches caller-supplied URLs. Upstream fetches go only to a fixed allowlist: `registry.npmjs.org`, `pypi.org`, `api.deps.dev`, `api.osv.dev`, `endoflife.date`, `api.github.com` (enrichment job only).
- All caller input is validated (ecosystem allowlist, package-name regexes, version-string regexes, body size caps) before any upstream call or database access.
- Upstream content (release notes, changelogs, metadata) is treated as **untrusted data**: it is normalized into short facts with provenance and is never interpreted as instructions by the service or by any operations tooling.
- Telemetry stores no secrets, no request bodies, and only hashed caller identifiers.
- Legacy API keys are stored as SHA-256 hashes only and are compatibility
  identities; new keys are not issued and keys never bypass the rolling trial
  or x402 payment gate.
- Payment identifiers and EIP-3009 nonces are hashed for replay/conflict
  checks. Pending authorizations are encrypted for bounded reconciliation; no
  buyer private key is ever stored.

## Reporting a vulnerability

Open a GitHub security advisory on this repository, or file an issue titled "SECURITY" without exploit details and a maintainer will follow up. Please do not publish exploit details before a fix is deployed.

## Scope notes

- Rate limiting is enforced per client/IP; abuse reports are welcome.
- The `/admin/*` surface requires a secret key and is used only by scheduled CI enrichment.
