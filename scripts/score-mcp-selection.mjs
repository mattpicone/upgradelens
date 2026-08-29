import fs from "node:fs";

const [corpusPath = "evals/mcp-tool-selection.json", resultsPath] = process.argv.slice(2);
if (!resultsPath) {
  console.error("Usage: node scripts/score-mcp-selection.mjs [corpus.json] results.json");
  process.exit(2);
}

const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
const resultDocument = JSON.parse(fs.readFileSync(resultsPath, "utf8"));
const rows = Array.isArray(resultDocument) ? resultDocument : resultDocument.results;
if (!Array.isArray(rows)) throw new Error("Results must be an array or an object with results[].");

const labels = corpus.labels;
const expectedIds = new Set(corpus.cases.map((testCase) => testCase.id));
const seen = new Set();
for (const row of rows) {
  if (!expectedIds.has(row.id)) throw new Error(`Unexpected result id: ${row.id}`);
  if (seen.has(row.id)) throw new Error(`Duplicate result id: ${row.id}`);
  seen.add(row.id);
}
const missing = [...expectedIds].filter((id) => !seen.has(id));
if (missing.length > 0) throw new Error(`Missing result ids: ${missing.join(", ")}`);

const byId = new Map(rows.map((row) => [row.id, row]));
const runCount = Math.min(
  ...rows.map((row) => (Array.isArray(row.first_actions) ? row.first_actions.length : 1)),
);
if (runCount < 1) throw new Error("At least one completed run is required.");
if (runCount < 3) throw new Error("The acceptance gate requires three completed selection runs.");

const actionAt = (row, run) =>
  Array.isArray(row.first_actions) ? row.first_actions[run] : row.first_action;
const sequenceAt = (row, run) =>
  Array.isArray(row.sequences) ? row.sequences[run] : row.sequence ?? [];
const flagAt = (row, field, run, fallback = false) => {
  const value = row[field];
  if (Array.isArray(value)) return value[run] ?? fallback;
  return value ?? fallback;
};
const sameSequence = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

const runs = [];
let totalInvented = 0;
let totalUnsupported = 0;
let totalUnsafeEdits = 0;
let totalArgumentChecks = 0;
let accurateArgumentChecks = 0;

for (let run = 0; run < runCount; run += 1) {
  const matrix = Object.fromEntries(
    labels.map((expected) => [expected, Object.fromEntries(labels.map((actual) => [actual, 0]))]),
  );
  let firstCorrect = 0;
  let positiveCorrect = 0;
  let positiveTotal = 0;
  let sequenceCorrect = 0;
  let negativeFalseInvocations = 0;
  const failures = [];

  for (const testCase of corpus.cases) {
    const row = byId.get(testCase.id);
    const actual = actionAt(row, run) ?? "missing";
    const sequence = sequenceAt(row, run);
    if (!labels.includes(actual)) throw new Error(`Invalid label ${actual} for ${testCase.id}, run ${run + 1}`);
    matrix[testCase.first_action][actual] += 1;
    if (actual === testCase.first_action) firstCorrect += 1;
    else failures.push({ id: testCase.id, metric: "first_action", expected: testCase.first_action, actual });
    if (testCase.first_action !== "none") {
      positiveTotal += 1;
      if (actual === testCase.first_action) positiveCorrect += 1;
      totalArgumentChecks += 1;
      if (flagAt(row, "required_arguments_accurate", run, false) === true) accurateArgumentChecks += 1;
    } else if (actual !== "none") {
      negativeFalseInvocations += 1;
    }
    if (sameSequence(sequence, testCase.sequence)) sequenceCorrect += 1;
    else failures.push({ id: testCase.id, metric: "sequence", expected: testCase.sequence, actual: sequence });
    if (flagAt(row, "invented_versions", run)) totalInvented += 1;
    if (flagAt(row, "unsupported_ecosystem_invocation", run)) totalUnsupported += 1;
    if (flagAt(row, "unsafe_edit_after_find", run)) totalUnsafeEdits += 1;
  }

  const perLabel = Object.fromEntries(
    labels.map((label) => {
      const tp = matrix[label][label];
      const expected = labels.reduce((sum, actual) => sum + matrix[label][actual], 0);
      const selected = labels.reduce((sum, gold) => sum + matrix[gold][label], 0);
      return [label, { precision: selected === 0 ? 0 : tp / selected, recall: expected === 0 ? 0 : tp / expected }];
    }),
  );
  runs.push({
    run: run + 1,
    first_action_accuracy: firstCorrect / corpus.cases.length,
    clear_positive_accuracy: positiveCorrect / positiveTotal,
    full_sequence_accuracy: sequenceCorrect / corpus.cases.length,
    negative_false_invocations: negativeFalseInvocations,
    per_label: perLabel,
    failures,
  });
}

let stableCases = 0;
for (const testCase of corpus.cases) {
  const row = byId.get(testCase.id);
  const first = actionAt(row, 0);
  const sequence = sequenceAt(row, 0);
  const stable = Array.from({ length: runCount }, (_, run) => run).every(
    (run) => actionAt(row, run) === first && sameSequence(sequenceAt(row, run), sequence),
  );
  if (stable) stableCases += 1;
}
const stability = stableCases / corpus.cases.length;
const requiredArgumentAccuracy =
  totalArgumentChecks === 0 ? 0 : accurateArgumentChecks / totalArgumentChecks;
const gates = corpus.acceptance;
const violations = [];
for (const run of runs) {
  if (run.clear_positive_accuracy < gates.clear_positive_accuracy_min) {
    violations.push(`run ${run.run}: clear-positive accuracy`);
  }
  if (run.full_sequence_accuracy < gates.full_sequence_accuracy_min) {
    violations.push(`run ${run.run}: full-sequence accuracy`);
  }
  if (run.negative_false_invocations > gates.negative_false_invocations_max) {
    violations.push(`run ${run.run}: negative false invocation`);
  }
  for (const [label, metrics] of Object.entries(run.per_label)) {
    if (metrics.precision < gates.per_tool_precision_recall_min || metrics.recall < gates.per_tool_precision_recall_min) {
      violations.push(`run ${run.run}: ${label} precision/recall`);
    }
  }
}
if (totalInvented > gates.invented_versions_max) violations.push("invented versions");
if (totalUnsupported > gates.unsupported_ecosystem_invocations_max) violations.push("unsupported ecosystem invocation");
if (totalUnsafeEdits > gates.unsafe_edits_after_find_max) violations.push("unsafe edit after find");
if (requiredArgumentAccuracy < gates.required_argument_accuracy_min) violations.push("required argument accuracy");
if (stability < gates.three_run_label_stability_min) violations.push("three-run stability");

console.log(
  JSON.stringify(
    {
      metadata: resultDocument.metadata ?? null,
      runs,
      aggregate: {
        run_count: runCount,
        label_and_sequence_stability: stability,
        invented_versions: totalInvented,
        unsupported_ecosystem_invocations: totalUnsupported,
        unsafe_edits_after_find: totalUnsafeEdits,
        required_argument_accuracy: requiredArgumentAccuracy,
      },
      acceptance_passed: violations.length === 0,
      violations,
    },
    null,
    2,
  ),
);
process.exitCode = violations.length === 0 ? 0 : 1;
