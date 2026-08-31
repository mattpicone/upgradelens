import { describe, expect, it } from "vitest";
import { getRandomValues, randomUUID, subtle } from "../src/uncrypto-worker";

describe("Cloudflare uncrypto adapter", () => {
  it("provides Web Crypto primitives and fills integer arrays", () => {
    const bytes = new Uint8Array(32);
    expect(getRandomValues(bytes)).toBe(bytes);
    expect(bytes.some((byte) => byte !== 0)).toBe(true);
    expect(randomUUID()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(subtle).toBeTruthy();
  });
});
