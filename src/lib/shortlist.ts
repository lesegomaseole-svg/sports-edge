/**
 * Daily-slip funnel, Stage 1 + 2 — added 2026-08-24. Pure code, no LLM,
 * no I/O: takes already-gathered candidate data (data completeness +
 * baseline Poisson probabilities per market) and decides which fixtures,
 * if any, are worth an expensive LLM look. Callers are responsible for
 * assembling FixtureCandidate[] from the DB/providers — kept separate so
 * this scoring logic is testable with synthetic input, same split as
 * devig.ts/poissonModel.ts/FootballDataCoUkProvider's aggregateTeamRates.
 *
 * REVISED FROM THE ORIGINAL BUILD BRIEF (2026-08-24): the brief's Stage 1
 * included a market-price-derived edge estimate and a liquidity proxy —
 * both need real bookmaker odds, and this app has no working non-LLM odds
 * source (The Odds API has been network-inert since 2026-08-03, and is
 * ALSO Zscaler-blocked on top of that on top of whichever network this
 * runs on — confirmed live). Odds/edge/liquidity are handled at Stage 3
 * instead, via the LLM's own web search — proven working for weeks of
 * real picks, unaffected by network-level blocks since it runs on
 * Anthropic's infrastructure, not this app's own network path. Stage 1/2
 * here shortlist on data completeness + how far the baseline model's
 * probability sits from a coin-flip (a no-odds-needed proxy for "worth
 * the expensive look") — same ~80% token-reduction goal, without a data
 * dependency that doesn't exist.
 */

export interface MarketEstimate {
  marketType: string;
  recommendation: string; // human-readable, e.g. "Over 2.5 goals", "Arsenal to win"
  baselineProbability: number; // 0-1, from the Poisson model
}

export interface FixtureCandidate {
  eventId: number;
  sportKey: string;
  leagueTitle: string;
  homeTeam: string;
  awayTeam: string;
  /**
   * 0-1. Callers decide how to compute this from what's actually
   * available (e.g. Event.dataScore, whether a Poisson baseline exists
   * for this league/these teams, stats/news presence) — this module just
   * gates and ranks on the number, it doesn't compute it.
   */
  dataCompleteness: number;
  completenessReasons: string[]; // human-readable, surfaced in NO_QUALIFYING_SLIP explanations
  /** Every viable baseline-model market estimate for this fixture — may be empty if no Poisson baseline exists (e.g. league not covered by football-data.co.uk, or either team below MIN_MATCHES_FOR_RATE). */
  markets: MarketEstimate[];
}

export interface ShortlistedCandidate {
  candidate: FixtureCandidate;
  /** The single most "interesting" market on this fixture — one leg per fixture, matching Stage 4's independence rule, decided here rather than left for later. */
  bestMarket: MarketEstimate;
  /** |probability - 0.5|, doubled to a 0-1 scale — how far from a coin-flip the baseline model's best market sits. */
  interestScore: number;
}

export interface ShortlistConfig {
  dataCompletenessFloor: number;
  shortlistSize: number;
  /** Minimum interestScore for a market to be considered at all — filters out fixtures where even the baseline model's best market is close to a coin-flip (nothing to justify the expensive look). */
  minInterestScore: number;
}

export const DEFAULT_SHORTLIST_CONFIG: ShortlistConfig = {
  dataCompletenessFloor: 0.6,
  shortlistSize: 8,
  minInterestScore: 0.08, // baseline probability at least ~54%/46% either side of 50/50
};

export interface ShortlistResult {
  shortlist: ShortlistedCandidate[];
  /**
   * First-class outcome, not an error — see the build brief's own framing.
   * False means: don't even attempt Stage 3, go straight to
   * NO_QUALIFYING_SLIP and skip spending any LLM tokens on a shortlist
   * that structurally can't produce a slip (fewer than 2 candidates can
   * never satisfy Stage 4's MIN_LEGS=2).
   */
  worthAttemptingSlip: boolean;
  reasons: string[]; // why worthAttemptingSlip is false, or a summary if true
}

export function buildShortlist(candidates: FixtureCandidate[], config: ShortlistConfig = DEFAULT_SHORTLIST_CONFIG): ShortlistResult {
  const reasons: string[] = [];

  const completeEnough = candidates.filter((c) => c.dataCompleteness >= config.dataCompletenessFloor);
  if (completeEnough.length < candidates.length) {
    reasons.push(
      `${candidates.length - completeEnough.length} of ${candidates.length} fixtures excluded below the data-completeness floor (${config.dataCompletenessFloor}).`
    );
  }

  const scored: ShortlistedCandidate[] = [];
  for (const candidate of completeEnough) {
    if (candidate.markets.length === 0) continue; // no baseline model available for this fixture at all

    let best: MarketEstimate | null = null;
    let bestScore = -1;
    for (const m of candidate.markets) {
      const score = Math.abs(m.baselineProbability - 0.5) * 2; // 0-1 scale
      if (score > bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (best && bestScore >= config.minInterestScore) {
      scored.push({ candidate, bestMarket: best, interestScore: bestScore });
    }
  }

  scored.sort((a, b) => b.interestScore - a.interestScore);
  const shortlist = scored.slice(0, config.shortlistSize);

  // MIN_LEGS for the eventual combo is 2 (Stage 4) — fewer than 2 genuine
  // candidates here means a qualifying slip is structurally impossible
  // downstream no matter what Stage 3/4 find, so don't spend tokens
  // finding that out the expensive way.
  const worthAttemptingSlip = shortlist.length >= 2;
  if (!worthAttemptingSlip) {
    reasons.push(`Only ${shortlist.length} fixture(s) cleared both the completeness floor and the minimum interest score — need at least 2 to attempt a slip.`);
  } else {
    reasons.push(`${shortlist.length} fixture(s) shortlisted for LLM analysis, out of ${candidates.length} considered.`);
  }

  return { shortlist, worthAttemptingSlip, reasons };
}
