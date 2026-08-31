import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

function acceptance(overrides = {}) {
  return {
    free_call: { payment_made: false, payment_status: "trial" },
    paid_call: { payment_status: "settled" },
    idempotent_retry: { payment_status: "cached_settlement", same_transaction: true },
    unsuitable_task_rejected: true,
    bazaar_mcp: { ok: true },
    dashboard_revenue: { before: 0, after: 0, unchanged_by_testnet: true },
    per_tool_testnet: [
      { tool: "check_dependency_upgrade", transaction: `0x${"1".repeat(64)}`, payment_status: "settled" },
      { tool: "find_safe_upgrade_target", transaction: `0x${"2".repeat(64)}`, payment_status: "settled" },
      { tool: "plan_dependency_upgrade", transaction: `0x${"3".repeat(64)}`, payment_status: "settled" },
    ],
    ...overrides,
  };
}

function runAttestation(report) {
  const directory = mkdtempSync(join(tmpdir(), "upgradelens-attestation-"));
  temporaryDirectories.push(directory);
  const reportPath = join(directory, "acceptance.json");
  writeFileSync(reportPath, JSON.stringify(report));
  return spawnSync(process.execPath, ["scripts/create-rollout-attestation.mjs", "--allow-dirty"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      ...process.env,
      TESTNET_ACCEPTANCE_FILE: reportPath,
      X402_PAY_TO: "0x1111111111111111111111111111111111111111",
    },
  });
}

describe("rollout attestation evidence", () => {
  it("distills a complete acceptance report without retaining result payloads", () => {
    const result = runAttestation(acceptance({ private_result_data: "must-not-be-retained" }));
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.attestation.network).toBe("eip155:84532");
    expect(output.acceptance.tools).toHaveLength(3);
    expect(result.stdout).not.toContain("must-not-be-retained");
  });

  it("rejects incomplete or non-unique controlled settlement evidence", () => {
    const invalid = acceptance({
      bazaar_mcp: { ok: false },
      per_tool_testnet: [
        { tool: "check_dependency_upgrade", transaction: `0x${"1".repeat(64)}`, payment_status: "settled" },
        { tool: "find_safe_upgrade_target", transaction: `0x${"1".repeat(64)}`, payment_status: "settled" },
      ],
    });
    const result = runAttestation(invalid);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("does not prove");
  });
});
