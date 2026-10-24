/* The seed import for the operations-research category: converts the committed survey and its curation into keepset entries for tasks/v1.

   pnpm run seed:import:or [--check]

   It reads scripts/seed/sources/or-datasets-survey.json (the survey, read only, like every upstream source) and scripts/seed/sources/or-survey-curation.json (what each surveyed dataset's download gives and how its columns map onto the tasks/v1 node), and scripts/seed/sources/download-sizes.json (the size each host states for a download, written by probe-download-sizes.ts), and writes catalogue/entries/<id>.json for every surveyed dataset and the report beside this script. Every surveyed dataset gets an entry: one with a recipe is fetchable, one without says why in its not-fetchable reason, and the report lists each once. An entry an earlier import wrote that this one does not produce is deleted, and entries from other imports are never touched, an id they hold being refused.

   --check writes nothing and exits non-zero when the committed entries or report differ from what the inputs produce. */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "../../src/serialise";
import { convertSurvey } from "./convert-or";
import { DownloadSizesSchema } from "./download-sizes";
import { apply, entryWrites, reportedIds, staleEntries } from "./emit";
import { SurveySourceSchema } from "./or-survey";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const entriesDir = join(repoRoot, "catalogue/entries");
const reportPath = join(here, "or-datasets-survey.report.json");
const surveyPath = join(here, "sources/or-datasets-survey.json");
const curationPath = join(here, "sources/or-survey-curation.json");
const sizesPath = join(here, "sources/download-sizes.json");

const { values } = parseArgs({ options: { check: { type: "boolean" } }, strict: true });

const survey = SurveySourceSchema.parse(JSON.parse(readFileSync(surveyPath, "utf8")));
const previous = existsSync(reportPath) ? reportedIds(readFileSync(reportPath, "utf8"), relative(repoRoot, reportPath), () => true) : undefined;
// The ids other imports hold: every entry file in the catalogue except the ones this import wrote before.
const takenIds = new Set(readdirSync(entriesDir).map((name) => name.replace(/\.json$/, "")).filter((id) => !(previous?.has(id) ?? false)));
const { entries, report } = convertSurvey(survey, JSON.parse(readFileSync(curationPath, "utf8")), takenIds);

const writes = entryWrites(entries, entriesDir, DownloadSizesSchema.parse(JSON.parse(readFileSync(sizesPath, "utf8"))));
writes.set(reportPath, canonicalJson(report));
const stale = staleEntries(entriesDir, previous, new Set(entries.map((entry) => entry.id)));

apply({ writes, stale }, repoRoot, values.check === true);
if (values.check === true) {
  console.log(`The committed or import output matches: ${String(entries.length)} entries and the report.`);
} else {
  const counts = new Map<string, number>();
  for (const outcome of report.outcomes) {
    counts.set(outcome.recipe, (counts.get(outcome.recipe) ?? 0) + 1);
  }
  console.log(`Wrote ${String(entries.length)} entries and ${relative(repoRoot, reportPath)} (${[...counts].map(([recipe, count]) => `${recipe} ${String(count)}`).join(", ")}); removed ${String(stale.length)} stale entries.`);
}
