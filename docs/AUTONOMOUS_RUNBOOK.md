# UpgradeLens autonomous runbook

This runbook is for agents and operators maintaining the v0.3 machine
contract. It is intentionally credential-free: no command below creates a
merchant payment or publishes an unobserved success claim.

## Local gates

```sh
npm ci
npm run typecheck
npm run contract:check
npm test
npm run operator:status
```

`npm run buyer:harness` starts from public discovery APIs and must not be
configured with the UpgradeLens name, repository, domain, or MCP URL. It may
inspect metadata and invoke the one free unit. `npm run payment:probe` sends a
single no-payment request and verifies the standards-shaped challenge when a
paid mode is configured. For the controlled Sepolia identity, set
`MCP_PATH=/mcp-testnet` and `MCP_TESTNET_TOKEN`; the probe still never signs,
settles, or invokes a business handler.

The controlled release proof is generated without mainnet activity:

```sh
MCP_PATH=/mcp-testnet npm run --silent buyer:harness -- --acceptance > /tmp/upgradelens-testnet-acceptance.json
TESTNET_ACCEPTANCE_FILE=/tmp/upgradelens-testnet-acceptance.json npm run rollout:attest -- --sql
```

The first command additionally requires `MCP_TESTNET_TOKEN`,
`BUYER_PRIVATE_KEY`, and `OWNER_TOKEN` in the environment. The second requires
the matching `X402_PAY_TO`. It refuses reports that do not prove a trial result,
one unique Sepolia settlement for each of the three discovered tools, a cached
authorization retry, brandless Bazaar MCP discovery, unsuitable-task rejection,
and unchanged eligible-mainnet dashboard revenue. The emitted SQL stores a
sanitized proof alongside the rollout attestation; mainnet refuses to activate
without both matching records.

`MCP_TESTNET_TOKEN` must be distinct from `OWNER_TOKEN` and from every legacy
API client key. It authorizes the hidden route but must not classify the buyer
as internal, otherwise the acceptance harness correctly refuses the run as an
owner-free bypass.

## D1 and deployment

Apply migrations in numeric order. The v0.3 state is added by
`migrations/0006_machine_payments.sql` and is safe to re-run. Deploy with
`wrangler deploy`, then run the operator status command against the public
`PUBLIC_BASE_URL`. A deployment is not a mainnet release until the exact
contract version, lockfile, tests, and testnet attestation are present.

## Payment mode gates

`PAYMENT_MODE=validation` is the safe default. `testnet` additionally requires
`TRIAL_HMAC_SECRET`, `PAYMENT_RECOVERY_SECRET`, CDP facilitator credentials,
and a valid EVM recipient. `mainnet` requires all of those plus the release
fingerprints from the attestation (`RELEASE_GIT_SHA`,
`RELEASE_LOCKFILE_HASH`, and `RELEASE_SUITE_HASH`) and a matching testnet
rollout attestation (contract version, price, network, and recipient hash).
`paused` serves no paid calls after the rolling free unit is consumed. Any
missing prerequisite fails closed with a machine-readable error.

The capital policy is strict: owner funds are never used. Testnet acceptance
uses only free Base Sepolia faucet tokens. Mainnet facilitator or gas costs may
be covered only by a capped reserve of already-earned merchant revenue; there
are no cards, fiat top-ups, or owner-funded retries. If the earned reserve is
not available, remain in validation/paused mode.

Both `TRIAL_HMAC_SECRET` and `PAYMENT_RECOVERY_SECRET` must contain at least
32 bytes. They must be independently generated values; neither is a wallet
key, and neither should be reused as one.

`KNOWN_UNIT_COST_MICROS` defaults to a conservative 1,000 USD micros per
analysis. Mainnet payment readiness fails closed if this value is invalid or
exceeds 2,500 micros, because that would reduce the $0.01 unit's known gross
margin below 75%. Update it when evidenced facilitator or settlement costs
change; settled ledger entries use the same value.

For controlled acceptance only, an owner may set `MCP_TESTNET_TOKEN` to expose
the non-advertised same-Worker `/mcp-testnet` identity. It forces Base Sepolia
mode and is classified as verification traffic; production Registry metadata
continues to advertise `/mcp` only.

Only the merchant's recoverable wallet and facilitator credentials are owner
inputs. Never put a private key in the repository or in payment recovery
records; recovery data is encrypted and limited to the exact authorization
needed for reconciliation.

## Discovery status

The operator status output records MCP Registry and Bazaar states as
`absent`, `testnet_indexed`, `production_awaiting_first_settlement`,
`production_indexed`, or `curated`. A checked-in manifest is not proof of
external indexing. Confirm public Registry results and a settled Bazaar
listing separately.

## Dashboard definitions

The owner view reports only all distinct external business units, good units
whose results were delivered, and unique eligible Base-mainnet USDC revenue
net of refunds. Protocol discovery, tools/list, owner tests, validators,
crawlers, testnet payments, duplicate/replayed/failed payments, and legacy
rows are retained for audit but cannot increase those headline numbers.
