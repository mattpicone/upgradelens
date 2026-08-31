#!/usr/bin/env node

// Produce the exact attestation payload required before mainnet activation.
// This is intentionally an offline artifact generator; it never sends a
// transaction or writes D1. Apply the emitted values only after the testnet
// acceptance suite has observed a real settlement.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const root = new URL("..", import.meta.url);
const text = async (name) => readFile(new URL(name, root), "utf8");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
if (gitStatus && !process.argv.includes("--allow-dirty")) {
  console.error("The worktree is dirty; commit the deployed build before creating an attestation (or pass --allow-dirty for a local rehearsal).\n");
  process.exit(2);
}
const lockfile = await text("package-lock.json");
const packageJson = JSON.parse(await text("package.json"));
const suiteFiles = execFileSync(
  "git",
  ["ls-files", "test", "src/payment.ts", "src/contract.ts", "src/mcp/server.ts", "migrations/0006_machine_payments.sql", "package.json"],
  { cwd: root, encoding: "utf8" },
).trim().split("\n").filter(Boolean).sort();
const suiteManifest = (await Promise.all(
  suiteFiles.map(async (path) => `${path}\n${await text(path)}`),
)).join("\n---\n");
const acceptanceFile = process.env.TESTNET_ACCEPTANCE_FILE;
const recipient = process.env.X402_PAY_TO?.toLowerCase();
if (!acceptanceFile || !recipient) {
  console.error("TESTNET_ACCEPTANCE_FILE and X402_PAY_TO are required; no attestation was generated.");
  process.exit(2);
}
if (!/^0x[0-9a-f]{40}$/.test(recipient)) {
  console.error("X402_PAY_TO must be a valid EVM address; no attestation was generated.");
  process.exit(2);
}
let acceptance;
try {
  acceptance = JSON.parse(await readFile(acceptanceFile, "utf8"));
} catch (error) {
  console.error(`Could not parse TESTNET_ACCEPTANCE_FILE: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
const toolSettlements = Array.isArray(acceptance.per_tool_testnet) ? acceptance.per_tool_testnet : [];
const transactions = toolSettlements.map((entry) => entry?.transaction);
const expectedTools = ["check_dependency_upgrade", "find_safe_upgrade_target", "plan_dependency_upgrade"];
const acceptedTools = toolSettlements.map((entry) => entry?.tool).sort();
const validAcceptance =
  acceptance.free_call?.payment_status === "trial" &&
  acceptance.free_call?.payment_made === false &&
  acceptance.paid_call?.payment_status === "settled" &&
  acceptance.idempotent_retry?.payment_status === "cached_settlement" &&
  acceptance.idempotent_retry?.same_transaction === true &&
  acceptance.unsuitable_task_rejected === true &&
  acceptance.bazaar_mcp?.ok === true &&
  acceptance.dashboard_revenue?.unchanged_by_testnet === true &&
  acceptance.dashboard_revenue?.before === acceptance.dashboard_revenue?.after &&
  JSON.stringify(acceptedTools) === JSON.stringify(expectedTools) &&
  transactions.length === 3 &&
  new Set(transactions).size === 3 &&
  transactions.every((transaction) => typeof transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(transaction)) &&
  toolSettlements.every((entry) => entry?.payment_status === "settled");
if (!validAcceptance) {
  console.error("The acceptance report does not prove free use, all three testnet settlements, cached retry, Bazaar discovery, unsuitable-task rejection, and zero revenue impact.");
  process.exit(2);
}
const suiteHash = sha(suiteManifest);
const lockfileHash = sha(lockfile);
const recipientHash = sha(recipient);
const acceptanceEvidence = {
  git_sha: gitSha,
  lockfile_hash: lockfileHash,
  suite_hash: suiteHash,
  recipient_hash: recipientHash,
  network: "eip155:84532",
  free_payment_status: acceptance.free_call.payment_status,
  tools: toolSettlements.map(({ tool, transaction }) => ({ tool, transaction })),
  idempotent_retry: true,
  unsuitable_task_rejected: true,
  bazaar_mcp_discovered: true,
  dashboard_revenue_unchanged: true,
};
const attestation = {
  git_sha: gitSha,
  lockfile_hash: lockfileHash,
  suite_hash: suiteHash,
  testnet_transaction: transactions[0],
  service_version: packageJson.version,
  price_micros: 10000,
  network: "eip155:84532",
  recipient_hash: recipientHash,
  passed_at: new Date().toISOString(),
};
if (process.argv.includes("--sql")) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  console.log(`INSERT OR IGNORE INTO rollout_attestations (git_sha,lockfile_hash,suite_hash,testnet_transaction,service_version,price_micros,network,recipient_hash,passed_at) VALUES (${quote(attestation.git_sha)},${quote(attestation.lockfile_hash)},${quote(attestation.suite_hash)},${quote(attestation.testnet_transaction)},${quote(attestation.service_version)},${attestation.price_micros},${quote(attestation.network)},${quote(attestation.recipient_hash)},${quote(attestation.passed_at)});`);
  console.log(`INSERT INTO discovery_status (channel,state,evidence_json,checked_at) VALUES ('testnet_acceptance','passed',${quote(JSON.stringify(acceptanceEvidence))},${quote(attestation.passed_at)}) ON CONFLICT(channel) DO UPDATE SET state=excluded.state,evidence_json=excluded.evidence_json,checked_at=excluded.checked_at;`);
} else console.log(JSON.stringify({ attestation, acceptance: acceptanceEvidence }, null, 2));
