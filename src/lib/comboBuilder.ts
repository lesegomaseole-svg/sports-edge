/**
 * Daily-slip funnel, Stage 4's combo construction + Stage 5's output shape
 * — added 2026-08-24. Takes EV-gated legs (src/lib/evGate.ts) and either
 * builds a combined slip targeting ~2.00 odds (the original build brief's
 * spec) or surfaces qualifying legs as independent singles — see this
 * module's own commit message for why BOTH exist rather than picking one:
 * the systematic-combo approach is a real strategy pivot from where this
 * app's own established guidance landed after a real 7-leg loss (singles/
 * small combos, only with genuine per-leg edge, never chasing a target
 * odds number), and the honest way to resolve that disagreement is to let
 * real settled results decide, not pick one by default.
 *
 * NO_QUALIFYING_SLIP is a first-class successful outcome here, not an
 * error — see buildCombo's own return type. A system required to output
 * a slip every day will manufacture one on days nothing qualifies, and
 * manufactured slips are where losses come from.
 */
import { GatedLeg } from "./evGate";

export interface SlipLeg extends GatedLeg {
  leagueTitle: string;
  homeTeam: string;
  awayTeam: string;
}

export interface ComboConfig {
  targetOddsMin: number;
  targetOddsMax: number;
  minLegs: number;
  maxLegs: number;
  correlationHaircut: number;
}

export const DEFAULT_COMBO_CONFIG: ComboConfig = {
  targetOddsMin: 1.9,
  targetOddsMax: 2.2,
  minLegs: 2,
  maxLegs: 3,
  correlationHaircut: 0.1,
};

export interface DailySlip {
  legs: SlipLeg[];
  combinedOdds: number;
  naiveJointProbability: number;
  correlationAdjustedProbability: number;
  impliedProbabilityFromOdds: number;
  estimatedEdge: number;
}

export type SlipOutcome = { type: "SLIP"; slip: DailySlip } | { type: "NO_QUALIFYING_SLIP"; reason: string };

/**
 * Independence rules enforced here: max 1 leg per fixture (already
 * guaranteed upstream — shortlist.ts picks one market per fixture before
 * legs ever reach the EV gate) and max 1 leg per competition. NOT yet
 * enforced, honestly flagged rather than silently skipped: "no two legs
 * sharing a referee or venue" and "prefer different market types" from
 * the original build brief — referee/venue data isn't currently threaded
 * through this pipeline (it exists in some LLM search results but isn't
 * captured as structured data anywhere), so this is a real gap, not an
 * oversight to pretend isn't there.
 */
export function buildCombo(legs: SlipLeg[], config: ComboConfig = DEFAULT_COMBO_CONFIG): SlipOutcome {
  const qualifying = legs.filter((l) => l.passed);
  if (qualifying.length < config.minLegs) {
    return { type: "NO_QUALIFYING_SLIP", reason: `Only ${qualifying.length} leg(s) passed the EV gate — need at least ${config.minLegs}.` };
  }

  // Prefer fewer legs (brief's own rationale: the vig compounds per leg,
  // so a 2-leg route to 2.00 pays it twice, a 3-leg route pays it three
  // times, for the same target return) — try smaller combos first.
  for (let size = config.minLegs; size <= config.maxLegs; size++) {
    const valid = combinationsOfSize(qualifying, size)
      .filter((combo) => new Set(combo.map((l) => l.leagueTitle)).size === combo.length) // max 1 per competition
      .map((combo) => toSlip(combo, config))
      .filter((slip) => slip.combinedOdds >= config.targetOddsMin && slip.combinedOdds <= config.targetOddsMax);

    if (valid.length > 0) {
      // Tie-break: highest estimated edge among valid combos at this leg count.
      valid.sort((a, b) => b.estimatedEdge - a.estimatedEdge);
      return { type: "SLIP", slip: valid[0] };
    }
  }

  return {
    type: "NO_QUALIFYING_SLIP",
    reason: `${qualifying.length} leg(s) passed the EV gate, but no combination of ${config.minLegs}-${config.maxLegs} hit the ${config.targetOddsMin}-${config.targetOddsMax} odds target without violating the one-leg-per-competition rule.`,
  };
}

/** Every EV-gated leg surfaced independently, no combo construction — the alternate, non-pivoted mode. Sorted by edge, strongest first. */
export function buildSinglesRecommendations(legs: SlipLeg[]): SlipLeg[] {
  return legs.filter((l) => l.passed).sort((a, b) => b.edge - a.edge);
}

function toSlip(combo: SlipLeg[], config: ComboConfig): DailySlip {
  const combinedOdds = combo.reduce((product, l) => product * l.price, 1);
  const naiveJointProbability = combo.reduce((product, l) => product * l.adjustedProbability, 1);
  const correlationAdjustedProbability = naiveJointProbability * (1 - config.correlationHaircut);
  const impliedProbabilityFromOdds = 1 / combinedOdds;
  return {
    legs: combo,
    combinedOdds,
    naiveJointProbability,
    correlationAdjustedProbability,
    impliedProbabilityFromOdds,
    estimatedEdge: correlationAdjustedProbability - impliedProbabilityFromOdds,
  };
}

function combinationsOfSize<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items;
  const withFirst = combinationsOfSize(rest, size - 1).map((c) => [first, ...c]);
  const withoutFirst = combinationsOfSize(rest, size);
  return [...withFirst, ...withoutFirst];
}
