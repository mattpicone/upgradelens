// Input validation at the trust boundary. Everything a caller sends is
// validated before any upstream fetch or DB touch.

import type { Ecosystem, UpgradeCheckRequest } from "./types";

const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYPI_NAME_RE = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const VERSION_RE = /^[0-9A-Za-z.+!*_-]{1,64}$/;
const RUNTIME_RE = /^[0-9A-Za-z.-]{1,32}$/;

export class ValidationError extends Error {
  constructor(
    public field: string,
    message: string,
  ) {
    super(message);
  }
}

export function validateEcosystem(v: unknown): Ecosystem {
  if (v !== "npm" && v !== "pypi") {
    throw new ValidationError(
      "ecosystem",
      `Unsupported ecosystem ${JSON.stringify(v)}. Supported: "npm", "pypi".`,
    );
  }
  return v;
}

export function validatePackageName(eco: Ecosystem, v: unknown): string {
  if (typeof v !== "string" || v.length === 0 || v.length > 214) {
    throw new ValidationError("package", "package must be a non-empty string (max 214 chars).");
  }
  if (eco === "npm") {
    if (!NPM_NAME_RE.test(v)) throw new ValidationError("package", `Invalid npm package name.`);
    return v;
  }
  if (!PYPI_NAME_RE.test(v)) throw new ValidationError("package", `Invalid PyPI package name.`);
  // PEP 503 normalization
  return v.toLowerCase().replace(/[._-]+/g, "-");
}

export function validateVersion(field: string, v: unknown): string {
  if (typeof v !== "string" || !VERSION_RE.test(v)) {
    throw new ValidationError(field, `${field} must be a valid version string (max 64 chars).`);
  }
  return v.replace(/^[=v\s]+/, "");
}

export function validateRuntime(v: unknown): { node?: string; python?: string } | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") throw new ValidationError("runtime", "runtime must be an object.");
  const out: { node?: string; python?: string } = {};
  const r = v as Record<string, unknown>;
  for (const key of ["node", "python"] as const) {
    const val = r[key] ?? (key === "node" ? r["language_version"] : undefined);
    if (val !== undefined) {
      if (typeof val !== "string" || !RUNTIME_RE.test(val)) {
        throw new ValidationError(`runtime.${key}`, `runtime.${key} must be a short version string.`);
      }
      out[key] = val;
    }
  }
  return out;
}

export function validateCheckRequest(body: unknown): UpgradeCheckRequest {
  if (typeof body !== "object" || body === null) {
    throw new ValidationError("body", "Request body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  const ecosystem = validateEcosystem(b.ecosystem);
  return {
    ecosystem,
    package: validatePackageName(ecosystem, b.package),
    current_version: validateVersion("current_version", b.current_version),
    target_version: validateVersion("target_version", b.target_version),
    runtime: validateRuntime(b.runtime ?? b.environment),
  };
}

export const MAX_BODY_BYTES = 32 * 1024;
export const MAX_BATCH_PAIRS = 8; // subrequest budget on Workers free plan
