/**
 * Daily-slip funnel, Stage 4's leg-qualification gate — added 2026-08-24.
 * Deliberately separate from combo construction (which stage the legs
 * that pass this get built INTO is a bigger, still-open question — see
 * this commit's message). This part isn't controversial regardless of
 * that answer: a leg with no edge over the market shouldn't be bet
 * whether it ends up in a combo or recommended as a single.
 *
 * A leg qualifies only if the LLM-adjusted probability (Stage 3 output)
 * clears the de-vigged market probability (src/lib/devig.ts) by at least
 * EDGE_THRESHOLD. There is no such thing as a filler leg — one that fails
 * this is discarded, never added just to help hit an odds target.
 */

export interface LegCandidate {
  eventId: number;
  marketType: string;
  recommendation: string;
  adjustedProbability: number; // Stage 3 LLM output, 0-1
  devigedMarketProbability: number; // from devig.ts, run against Stage 3's found odds
  price: number; // decimal odds for this specific outcome
}

export interface GatedLeg extends LegCandidate {
  edge: number; // adjustedProbability - devigedMarketProbability
  passed: boolean;
}

export const DEFAULT_EDGE_THRESHOLD = 0.03;

export function applyEvGate(candidates: LegCandidate[], edgeThreshold: number = DEFAULT_EDGE_THRESHOLD): GatedLeg[] {
  return candidates.map((c) => {
    const edge = c.adjustedProbability - c.devigedMarketProbability;
    return { ...c, edge, passed: edge > edgeThreshold };
  });
}
