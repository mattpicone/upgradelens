// Conservative, deterministic release-note extraction shared by the scheduled
// enrichment job and its tests. The extractor intentionally prefers missing a
// fact over turning a narrative mention of a breaking change into a claim.

const BREAKING_HEADING =
  /^#{1,6}\s+.*\b(breaking(?:\s+changes?)?|backwards?[-\s]+incompatible|removed(?:\s+apis?)?)\b/i;

// Conventional release-note marker only. Do not match prose that merely says
// "breaking change" (for example, a note explaining that one was reverted).
const BREAKING_MARKER =
  /^(?:[-*+]\s+|>\s*)?(?:\*\*|__)?BREAKING(?:\s+CHANGES?)?(?:\*\*|__)?\s*[:\-–—]\s*\S/i;

const NEGATED_OR_REVERTED = [
  /\bno (?:known |actual )?breaking changes?\b/i,
  /\bnot (?:a |an )?breaking change\b/i,
  /\bwithout (?:a |any )?breaking changes?\b/i,
  /\bbreaking changes?\b.{0,100}\b(?:reverted|rolled back|undone)\b/i,
  /\b(?:reverts?|reverted|rolls? back|rolled back|undoes?|undone)\b.{0,100}\bbreaking changes?\b/i,
];

const REFERENCE_ONLY =
  /^(?:for (?:a |the )?(?:complete|full) list|see |refer to |read (?:the )?).*\b(?:breaking changes?|migration guide|release notes?)\b/i;

function cleanFact(text) {
  return text
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
}

function isConcreteBreakingFact(text) {
  if (text.length <= 12 || REFERENCE_ONLY.test(text)) return false;
  return !NEGATED_OR_REVERTED.some((pattern) => pattern.test(text));
}

export function versionFromTag(tag) {
  const match = /v?(\d+[.\w!+-]*)/.exec(tag);
  return match ? match[1] : null;
}

// Extract bullets under explicit breaking/incompatibility/removal headings and
// conventional "BREAKING CHANGE:" markers. Short facts only; never documents.
export function extractBreaking(body) {
  const facts = [];
  const seen = new Set();
  const lines = (body ?? "").split(/\r?\n/).slice(0, 800);
  let inBreakingSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      inBreakingSection = BREAKING_HEADING.test(trimmed);
      continue;
    }

    const inSectionBullet = inBreakingSection && /^[-*+]\s+/.test(trimmed);
    const explicitMarker = BREAKING_MARKER.test(trimmed);
    if (!inSectionBullet && !explicitMarker) continue;

    const text = cleanFact(trimmed);
    if (!isConcreteBreakingFact(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({
      text,
      confidence: inSectionBullet ? 0.9 : 0.95,
      severity: explicitMarker ? "high" : "unknown",
    });
    if (facts.length >= 10) break;
  }

  return facts;
}
