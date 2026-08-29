import { describe, expect, it } from "vitest";
import { extractBreaking, versionFromTag } from "../scripts/release-note-extract.mjs";

describe("release-note breaking-change extraction", () => {
  it("extracts bullets only from explicit breaking sections", () => {
    const facts = extractBreaking(`
## Features
- Add a faster parser
## Breaking changes
- Remove the legacy createClient() signature
- Rename the timeout option to requestTimeout
## Fixes
- Correct a typo
`);
    expect(facts.map((fact) => fact.text)).toEqual([
      "Remove the legacy createClient() signature",
      "Rename the timeout option to requestTimeout",
    ]);
  });

  it("extracts conventional BREAKING CHANGE markers", () => {
    const facts = extractBreaking("- **BREAKING CHANGE**: Node 18 is now required");
    expect(facts).toEqual([
      {
        text: "**BREAKING CHANGE**: Node 18 is now required",
        confidence: 0.95,
        severity: "high",
      },
    ]);
  });

  it("does not turn narrative or reverted mentions into breaking facts", () => {
    const facts = extractBreaking(`
The prior release included an erroneous breaking change. The change has been fully reverted.
For a complete list of breaking changes, see the migration guide.
No actual breaking changes are present in this release.
`);
    expect(facts).toEqual([]);
  });

  it("filters negated bullets inside a breaking section", () => {
    const facts = extractBreaking(`
## Breaking changes
- No breaking changes in this patch.
- The removed legacy adapter is restored; the breaking change was reverted.
- The legacy /v1 endpoint was removed.
`);
    expect(facts.map((fact) => fact.text)).toEqual([
      "The legacy /v1 endpoint was removed.",
    ]);
  });

  it("cleans markdown and de-duplicates facts", () => {
    const facts = extractBreaking(`
## Backwards incompatible
- Replace [oldMethod](https://example.test/old) with newMethod
- Replace [oldMethod](https://example.test/old) with newMethod
`);
    expect(facts.map((fact) => fact.text)).toEqual([
      "Replace oldMethod with newMethod",
    ]);
  });

  it("parses common npm and PyPI release tags", () => {
    expect(versionFromTag("v5.1.0")).toBe("5.1.0");
    expect(versionFromTag("release-2.4.0rc1")).toBe("2.4.0rc1");
    expect(versionFromTag("not-a-version")).toBeNull();
  });
});
