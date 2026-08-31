import { HTTPFacilitatorClient } from "@x402/core/server";

const DEFAULT_CDP_FACILITATOR_URL = "https://api.cdp.coinbase.com/platform/v2/x402";

interface CdpFacilitatorArgs {
  apiKeyId?: string;
  apiKeySecret?: string;
  baseUrl?: string;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeSecret(secret: string): Uint8Array {
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(secret), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("CDP_API_KEY_SECRET must be a base64 Ed25519 key");
  }
  if (decoded.length !== 64) throw new Error("CDP_API_KEY_SECRET must decode to a 64-byte Ed25519 key");
  return decoded;
}

async function importSigningKey(secret: string): Promise<CryptoKey> {
  const decoded = decodeSecret(secret);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "OKP",
      crv: "Ed25519",
      d: base64Url(decoded.subarray(0, 32)),
      x: base64Url(decoded.subarray(32)),
      ext: true,
      key_ops: ["sign"],
    },
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

async function createJwt(
  keyId: string,
  key: Promise<CryptoKey>,
  requestMethod: "GET" | "POST",
  requestHost: string,
  requestPath: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({
    alg: "EdDSA",
    kid: keyId,
    typ: "JWT",
    nonce: crypto.randomUUID().replaceAll("-", ""),
  })));
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    sub: keyId,
    iss: "cdp",
    uris: [`${requestMethod} ${requestHost}${requestPath}`],
    iat: now,
    nbf: now,
    exp: now + 120,
  })));
  const message = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    { name: "Ed25519" },
    await key,
    new TextEncoder().encode(message),
  );
  return `${message}.${base64Url(new Uint8Array(signature))}`;
}

export function createCdpFacilitatorClient(args: CdpFacilitatorArgs = {}): HTTPFacilitatorClient {
  const apiKeyId = args.apiKeyId;
  const apiKeySecret = args.apiKeySecret;
  if (!apiKeyId || !apiKeySecret) throw new Error("CDP facilitator credentials are required");

  const parsed = new URL(args.baseUrl ?? DEFAULT_CDP_FACILITATOR_URL);
  const basePath = parsed.pathname.replace(/\/$/, "");
  const signingKey = importSigningKey(apiKeySecret);
  const auth = async (method: "GET" | "POST", suffix: string) => ({
    Authorization: `Bearer ${await createJwt(apiKeyId, signingKey, method, parsed.host, `${basePath}/${suffix}`)}`,
  });

  return new HTTPFacilitatorClient({
    url: parsed.toString().replace(/\/$/, ""),
    createAuthHeaders: async () => ({
      verify: await auth("POST", "verify"),
      settle: await auth("POST", "settle"),
      supported: await auth("GET", "supported"),
    }),
  });
}
