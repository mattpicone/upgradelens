import { describe, expect, it } from "vitest";
import { createCdpFacilitatorClient } from "../src/cdp-facilitator";

describe("CDP facilitator client", () => {
  it("fails closed without both credentials", () => {
    expect(() => createCdpFacilitatorClient()).toThrow("credentials are required");
  });

  const live = process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET ? it : it.skip;
  live("authenticates to the read-only supported-method endpoint", async () => {
    const supported = await createCdpFacilitatorClient({
      apiKeyId: process.env.CDP_API_KEY_ID,
      apiKeySecret: process.env.CDP_API_KEY_SECRET,
    }).getSupported();
    expect(supported.kinds).toEqual(expect.arrayContaining([
      expect.objectContaining({ scheme: "exact", network: "eip155:84532" }),
      expect.objectContaining({ scheme: "exact", network: "eip155:8453" }),
    ]));
  });
});
