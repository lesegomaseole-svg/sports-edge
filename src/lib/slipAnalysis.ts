/**
 * Daily-slip funnel, Stage 3 — added 2026-08-24. Deliberately separate
 * from analyzeEvent.ts (the existing, live, manual-Analyse flow) even
 * though it reuses several of its proven pieces (buildStatsBlock/
 * buildNewsBlock/buildWeatherBlock, ClaudeCodeAgent.runPrompt) — a
 * SEPARATE prompt and output contract, not a modification to the
 * existing one, so nothing about what's already live and working changes.
 * See ClaudeCodeAgent.ts's runPrompt() comment and analyzeEvent.ts's
 * export changes for the specific reuse.
 *
 * Job, per the build brief: ADJUST OR VETO a baseline Poisson probability
 * (src/lib/poissonModel.ts via shortlist.ts), not generate a pick from
 * scratch — the market is already chosen (Stage 1/2's job), this stage's
 * only questions are "does real-world context change how likely this is,
 * and what are the actual current odds for it." Also the ONLY place in
 * this funnel that needs real odds, found via the LLM's own web search —
 * the one odds source that's proven working for weeks and isn't affected
 * by this network's Zscaler block on structured odds APIs (search runs on
 * Anthropic's infrastructure, not this app's own network path).
 */
import { ClaudeCodeAgent } from "../agents/ClaudeCodeAgent";
import { buildStatsBlock, buildNewsBlock, buildWeatherBlock } from "./analyzeEvent";
import { stripCitations } from "../agents/parseAgentJson";
import { MarketOutcome } from "./devig";

export interface SlipCandidateForAnalysis {
  eventId: number;
  sportKey: string;
  leagueTitle: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: Date;
  marketType: string;
  recommendation: string; // the specific selection, e.g. "Over 2.5 goals"
  /** Every outcome of this market, for the model to find real prices for — e.g. ["Over 2.5", "Under 2.5"] or ["Team A", "Draw", "Team B"]. Must include `recommendation` itself. */
  marketOutcomeLabels: string[];
  baselineProbability: number; // Stage 1/2's Poisson estimate for `recommendation`
}

export interface SlipLegAnalysis {
  veto: boolean;
  vetoReason: string | null;
  adjustedProbability: number;
  reasoning: string;
  dataGaps: string[];
  /** Null if the model couldn't find current odds for this market at all — callers must treat that as "can't gate this leg," not assume a price. */
  oddsFound: MarketOutcome[] | null;
  searchesUsed: number;
}

function matchesExpectedOutcomes(outcomes: MarketOutcome[], expectedLabels: string[]): boolean {
  if (outcomes.length !== expectedLabels.length) return false;
  const expectedLower = expectedLabels.map((l) => l.toLowerCase().trim());
  const seenLower = new Set<string>();
  for (const o of outcomes) {
    const lower = o.name.toLowerCase().trim();
    if (!expectedLower.includes(lower)) return false;
    if (seenLower.has(lower)) return false; // duplicate
    seenLower.add(lower);
  }
  return true;
}

function buildPrompt(candidate: SlipCandidateForAnalysis, statsBlock: string, newsBlock: string, weatherBlock: string | null): string {
  return `You are reviewing ONE specific betting market for a soccer fixture — you are NOT choosing the market yourself, that has already been decided. Your job is narrow: confirm, adjust, or veto a statistical baseline, and find the real current price.

FIXTURE: ${candidate.homeTeam} vs ${candidate.awayTeam} (${candidate.leagueTitle}), kicking off ${candidate.commenceTime.toISOString()}.

MARKET UNDER REVIEW: ${candidate.marketType} — "${candidate.recommendation}"
STATISTICAL BASELINE (Poisson model from recent league results, NOT a final judgment): ${(candidate.baselineProbability * 100).toFixed(1)}% probability.

VERIFICATION DATA (structured, may be incomplete — cross-check against your own search, don't treat either source as automatically correct):
${statsBlock}

${newsBlock}

${weatherBlock ?? "No weather data available for this fixture."}

YOUR TASKS, IN ORDER:
1. Search for the CURRENT real market price for "${candidate.recommendation}" AND every other outcome of the same market (${candidate.marketOutcomeLabels.join(", ")}) — you need all outcomes' prices, not just this one, to compute a fair de-vigged probability later. If different bookmakers quote different prices, pick ONE representative price per outcome (the most commonly-seen figure, or the first reliable one you find) — do not report the same outcome multiple times for different bookmakers, that will break the de-vig calculation, which needs exactly one price per outcome to sum correctly.
2. Search for anything that would change the baseline probability for THIS specific match — team news, injuries, lineup changes, current form, head-to-head, referee tendencies, anything materially relevant to "${candidate.recommendation}" specifically.
3. Decide: does the ${(candidate.baselineProbability * 100).toFixed(1)}% baseline still hold, does it need adjusting up or down, or should this market be VETOED outright because something you found makes the baseline unreliable for this specific match (e.g. a key player confirmed out, the baseline's underlying data is clearly stale for one of these teams, or you cannot find any real current pricing at all)? A veto is for "this baseline doesn't apply here," not just general uncertainty — genuine uncertainty should show up as a probability closer to 50%, not a veto.

Respond with ONLY this JSON object, no other text, no markdown code fence:
{
  "veto": false,
  "veto_reason": null,
  "adjusted_probability": 0.0,
  "reasoning": "your reasoning, citing what you found",
  "data_gaps": ["anything you couldn't verify"],
  "odds_found": {
    "outcomes": [{"name": "exact outcome label", "price": 0.0}],
    "found": true
  }
}

odds_found.outcomes MUST contain EXACTLY ${candidate.marketOutcomeLabels.length} entries — one per outcome (${candidate.marketOutcomeLabels.join(", ")}), no more, no fewer, and no duplicates. Each "name" must be EXACTLY one of those labels, verbatim — not a bookmaker name, not American-odds notation, not annotated with which book it came from. Each "price" must be a plain decimal price (e.g. 1.65), converted from American/fractional odds yourself if that's what you found, never left in the original notation.

If veto is true, adjusted_probability should still be your best honest estimate (don't leave it at the baseline arbitrarily) and veto_reason must be a specific, concrete reason — not "not confident." If you genuinely cannot find current odds for this market anywhere after searching, set odds_found.found to false and leave outcomes as an empty array — do not invent a price.`;
}

export async function analyzeSlipCandidate(candidate: SlipCandidateForAnalysis, agent: ClaudeCodeAgent = new ClaudeCodeAgent()): Promise<SlipLegAnalysis> {
  const [statsBlock, newsBlock, weatherBlock] = await Promise.all([
    buildStatsBlock(candidate.homeTeam, candidate.awayTeam, candidate.sportKey),
    buildNewsBlock(candidate.sportKey, candidate.homeTeam, candidate.awayTeam),
    buildWeatherBlock(candidate.homeTeam, candidate.sportKey, candidate.commenceTime),
  ]);

  const prompt = buildPrompt(candidate, statsBlock, newsBlock, weatherBlock);
  const { resultText } = await agent.runPrompt(prompt);
  return parseSlipAnalysis(resultText, candidate.marketOutcomeLabels);
}

/**
 * expectedOutcomeLabels (optional): when given, oddsFound is rejected
 * (set to null, not silently kept malformed) unless it has EXACTLY one
 * entry per expected label, case-insensitively, with no duplicates and no
 * extras. Added 2026-08-24 after a live test returned 3 "outcomes" for a
 * 2-outcome market — the same outcome listed twice under two different
 * bookmaker names. A stricter prompt reduces how often that happens but
 * shouldn't be the only safeguard; devigMarket() silently produces a
 * wrong (not erroring) result on a malformed market, so this needs to be
 * caught here, not downstream where it'd just look like a bad number.
 */
export function parseSlipAnalysis(text: string, expectedOutcomeLabels?: string[]): SlipLegAnalysis {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error(`Slip analysis response did not contain JSON: ${text.slice(0, 200)}`);
  }
  const parsed = JSON.parse(match[0]);

  if (typeof parsed.reasoning !== "string") {
    throw new Error("Slip analysis response missing required field: reasoning");
  }

  const adjustedProbability = Number(parsed.adjusted_probability);
  const veto = parsed.veto === true;
  const vetoReason = veto && typeof parsed.veto_reason === "string" && parsed.veto_reason.trim() ? stripCitations(parsed.veto_reason.trim()) : veto ? "veto=true but no reason given" : null;

  const dataGaps = Array.isArray(parsed.data_gaps) ? parsed.data_gaps.filter((v: unknown): v is string => typeof v === "string" && v.trim().length > 0).map(stripCitations) : [];

  let oddsFound: MarketOutcome[] | null = null;
  const oddsRaw = parsed.odds_found;
  if (oddsRaw && typeof oddsRaw === "object" && oddsRaw.found === true && Array.isArray(oddsRaw.outcomes)) {
    const outcomes: MarketOutcome[] = oddsRaw.outcomes
      .filter((o: unknown): o is { name: unknown; price: unknown } => !!o && typeof o === "object")
      .map((o: { name: unknown; price: unknown }) => ({ name: String(o.name), price: Number(o.price) }))
      .filter((o: MarketOutcome) => o.name.trim().length > 0 && Number.isFinite(o.price) && o.price > 1);

    if (outcomes.length > 0) {
      if (expectedOutcomeLabels && !matchesExpectedOutcomes(outcomes, expectedOutcomeLabels)) {
        // Malformed shape (wrong count, duplicate outcome, or a name that
        // doesn't match any expected label) — null, not a best-effort
        // guess, since devigMarket() would silently misnormalize this.
        oddsFound = null;
      } else {
        oddsFound = outcomes;
      }
    }
  }

  return {
    veto,
    vetoReason,
    adjustedProbability: Number.isFinite(adjustedProbability) ? Math.min(1, Math.max(0, adjustedProbability)) : 0.5,
    reasoning: stripCitations(parsed.reasoning),
    dataGaps,
    oddsFound,
    searchesUsed: 0, // set by the caller from ClaudeCodeAgent's own tracking if needed — not in this function's scope
  };
}
