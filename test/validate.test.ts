import { describe, expect, it } from "vitest";
import {
  validateCheckRequest,
  validateEcosystem,
  validatePackageName,
  validateVersion,
  ValidationError,
} from "../src/validate";

describe("validateEcosystem", () => {
  it("accepts npm and pypi only", () => {
    expect(validateEcosystem("npm")).toBe("npm");
    expect(validateEcosystem("pypi")).toBe("pypi");
    expect(() => validateEcosystem("cargo")).toThrow(ValidationError);
    expect(() => validateEcosystem(null)).toThrow(ValidationError);
  });
});

describe("validatePackageName", () => {
  it("accepts valid npm names including scopes", () => {
    expect(validatePackageName("npm", "express")).toBe("express");
    expect(validatePackageName("npm", "@angular/core")).toBe("@angular/core");
  });
  it("rejects invalid npm names", () => {
    expect(() => validatePackageName("npm", "UPPER")).toThrow(ValidationError);
    expect(() => validatePackageName("npm", "../etc/passwd")).toThrow(ValidationError);
    expect(() => validatePackageName("npm", "a".repeat(300))).toThrow(ValidationError);
    expect(() => validatePackageName("npm", "")).toThrow(ValidationError);
  });
  it("normalizes PyPI names per PEP 503", () => {
    expect(validatePackageName("pypi", "Django")).toBe("django");
    expect(validatePackageName("pypi", "python_dateutil")).toBe("python-dateutil");
    expect(validatePackageName("pypi", "zope.interface")).toBe("zope-interface");
  });
  it("rejects invalid pypi names", () => {
    expect(() => validatePackageName("pypi", "-leading")).toThrow(ValidationError);
    expect(() => validatePackageName("pypi", "has space")).toThrow(ValidationError);
  });
});

describe("validateVersion", () => {
  it("accepts and normalizes versions", () => {
    expect(validateVersion("v", "4.19.2")).toBe("4.19.2");
    expect(validateVersion("v", "v5.1.0")).toBe("5.1.0");
  });
  it("rejects dangerous or oversized strings", () => {
    expect(() => validateVersion("v", "1.0; DROP TABLE")).toThrow(ValidationError);
    expect(() => validateVersion("v", "9".repeat(100))).toThrow(ValidationError);
    expect(() => validateVersion("v", 42)).toThrow(ValidationError);
  });
});

describe("validateCheckRequest", () => {
  it("accepts a full valid request", () => {
    const req = validateCheckRequest({
      ecosystem: "npm",
      package: "express",
      current_version: "4.19.2",
      target_version: "5.1.0",
      runtime: { node: "20.11.0" },
    });
    expect(req.runtime?.node).toBe("20.11.0");
  });
  it("accepts 'environment' alias for runtime", () => {
    const req = validateCheckRequest({
      ecosystem: "pypi",
      package: "django",
      current_version: "3.2",
      target_version: "5.0",
      environment: { python: "3.12" },
    });
    expect(req.runtime?.python).toBe("3.12");
  });
  it("rejects non-object bodies and missing fields", () => {
    expect(() => validateCheckRequest("hi")).toThrow(ValidationError);
    expect(() => validateCheckRequest({ ecosystem: "npm" })).toThrow(ValidationError);
    expect(() =>
      validateCheckRequest({
        ecosystem: "npm",
        package: "x",
        current_version: "1.0.0",
        target_version: { evil: true },
      }),
    ).toThrow(ValidationError);
  });
  it("rejects malicious runtime values", () => {
    expect(() =>
      validateCheckRequest({
        ecosystem: "npm",
        package: "x",
        current_version: "1.0.0",
        target_version: "2.0.0",
        runtime: { node: "$(rm -rf /)" },
      }),
    ).toThrow(ValidationError);
  });
});
