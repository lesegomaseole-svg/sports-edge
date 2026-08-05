import { AgentRecommendation, DataAvailability, DataAvailabilityChecklist, Discrepancy, RunnerUp } from "./AgentProvider";

/**
 * Both LLM prompts ask for a JSON object back, but models sometimes wrap it
 * in prose or a code fence. This extracts the first {...} block and
 * validates the shape defensively rather than trusting the model blindly.
 *
 * `market` is only checked for being a non-empty string here — the valid
 * options are sport-specific, so real validation against the current
 * event's market menu happens in analyzeEvent.ts, which has the sport
 * context this function doesn't. A missing/non-string value defaults to
 * "none" rather than throwing, since a malformed market choice shouldn't
 * fail the whole pick when the recommendation/reasoning are otherwise fine.
 *
 * keyFactors/dataGaps/searchesPerformed/runnerUp (added 2026-08-01) are
 * all optional from the model's point of view — each defaults to an
 * empty array/null rather than throwing if absent or malformed, since
 * these are supplementary detail, not core to a usable pick.
 *
 * dataAvailability (added 2026-08-04) is different — it's a fixed
 * 9-category checklist, not optional supplementary detail, and a missing/
 * malformed entry for any category defaults to "unavailable" (see
 * parseDataAvailability) rather than being silently dropped, since the
 * whole point is knowing what the model actually had for every category,
 * every time, not just when it happens to be present.
 *
 * Citation markup stripping (added 2026-08-02): some providers' web
 * search/fetch tools annotate claims inline with raw <cite index="...">
 * text</cite> markup that's meant for a rendering layer, not for this
 * app's plain-text storage — confirmed live in one of 2026-08-01's picks,
 * where it leaked straight into the stored `reasoning`. stripCitations()
 * runs over every free-text field parsed here (not just reasoning — a
 * citation could just as plausibly land in dataGaps or a discrepancy's
 * fields, anywhere the model writes prose) so it can never reach storage,
 * while keeping the cited text itself intact — only the tag delimiters
 * are removed, not their content.
 */
export function parseAgentJson(text: string): AgentRecommendation {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Agent response did not contain JSON: ${text.slice(0, 200)}`);
  }

  const parsed = JSON.parse(match[0]);

  if (typeof parsed.recommendation !== "string" || typeof parsed.reasoning !== "string") {
    throw new Error("Agent response missing required fields (recommendation/reasoning)");
  }

  const confidence = Number(parsed.confidence);
  const market = typeof parsed.market === "string" && parsed.market.trim() ? parsed.market.trim() : "none";

  return {
    market,
    recommendation: stripCitations(parsed.recommendation),
    reasoning: stripCitations(parsed.reasoning),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5,
    keyFactors: stringArray(parsed.keyFactors),
    dataGaps: stringArray(parsed.dataGaps),
    dataAvailability: parseDataAvailability(parsed.dataAvailability),
    searchesPerformed: stringArray(parsed.searchesPerformed),
    runnerUp: parseRunnerUp(parsed.runnerUp),
    discrepancies: parseDiscrepancies(parsed.discrepancies),
  };
}

// Removes <cite ...> and </cite> tag delimiters only — the text between
// them (the actual cited claim) is left exactly as-is. Two independent
// replacements rather than one paired capture-group match, so it's
// correct regardless of how many citations appear, back-to-back or
// nested, in a single string.
export function stripCitations(value: string): string {
  return value.replace(/<cite[^>]*>/gi, "").replace(/<\/cite>/gi, "");
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map(stripCitations);
}

function parseRunnerUp(value: unknown): RunnerUp | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.market !== "string" || typeof v.whyWeaker !== "string" || !v.market.trim() || !v.whyWeaker.trim()) return null;
  return { market: stripCitations(v.market.trim()), whyWeaker: stripCitations(v.whyWeaker.trim()) };
}

const DATA_AVAILABILITY_KEYS: (keyof DataAvailabilityChecklist)[] = [
  "xg",
  "corners",
  "cards",
  "lineups",
  "injuries",
  "weather",
  "referee",
  "h2h",
  "oddsFeed",
];
const VALID_AVAILABILITY_VALUES: DataAvailability[] = ["available", "unavailable", "partial"];

// dataAvailability (added 2026-08-04): a missing or malformed value for
// any of the 9 fixed categories defaults to "unavailable" — the safe
// direction to fail in, since understating data quality just means a
// data gap that wasn't really there, while overstating it (defaulting to
// "available") could make a pick look better-supported than it was.
function parseDataAvailability(value: unknown): DataAvailabilityChecklist {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const result = {} as DataAvailabilityChecklist;
  for (const key of DATA_AVAILABILITY_KEYS) {
    const raw = v[key];
    result[key] = VALID_AVAILABILITY_VALUES.includes(raw as DataAvailability) ? (raw as DataAvailability) : "unavailable";
  }
  return result;
}

// discrepancies (added 2026-08-01): malformed entries are dropped
// individually rather than discarding the whole array — a partially
// malformed discrepancies list shouldn't fail an otherwise-usable pick.
function parseDiscrepancies(value: unknown): Discrepancy[] {
  if (!Array.isArray(value)) return [];
  const out: Discrepancy[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    if (typeof v.fact !== "string" || typeof v.searchValue !== "string" || typeof v.apiValue !== "string" || typeof v.resolution !== "string") continue;
    if (!v.fact.trim()) continue;
    out.push({
      fact: stripCitations(v.fact.trim()),
      searchValue: stripCitations(v.searchValue.trim()),
      apiValue: stripCitations(v.apiValue.trim()),
      resolution: stripCitations(v.resolution.trim()),
    });
  }
  return out;
}
