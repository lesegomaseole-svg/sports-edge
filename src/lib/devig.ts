/**
 * De-vigging — added 2026-08-24, part of the daily-slip funnel rework.
 *
 * Raw implied probability (1/decimal_price) for every outcome in a market
 * sums to MORE than 100% — that gap is the bookmaker's margin (the "vig"
 * or "overround"). Comparing a model's probability estimate against a raw
 * implied probability makes almost everything look +EV even when it isn't,
 * because the model is being compared against a number that's inflated by
 * construction. Every edge calculation in this app's funnel MUST go
 * through this first — no edge number anywhere should ever be computed
 * against a raw, un-devigged price.
 *
 * Multiplicative (proportional) method: divide each outcome's raw implied
 * probability by the market's total overround. Simple, standard, and
 * explicitly what the build brief called for as the starting method —
 * more sophisticated methods (Shin's method, etc.) correct for
 * longshot bias but add complexity not justified until this simpler
 * version is proven out.
 */

export interface MarketOutcome {
  name: string;
  price: number; // decimal odds, e.g. 1.85
}

export interface DevigedOutcome {
  name: string;
  price: number;
  rawImpliedProbability: number;
  devigedProbability: number;
}

export interface DevigedMarket {
  overround: number; // sum of raw implied probabilities — 1.0 = no margin, >1.0 = normal
  outcomes: DevigedOutcome[];
}

/**
 * `outcomes` must be every outcome of the SAME market for one bookmaker
 * (e.g. all 3 sides of a 1X2, or both sides of an over/under line) — the
 * overround calculation is only meaningful across a complete market, not
 * a single price in isolation.
 */
export function devigMarket(outcomes: MarketOutcome[]): DevigedMarket {
  if (outcomes.length === 0) {
    throw new Error("devigMarket requires at least one outcome");
  }
  for (const o of outcomes) {
    if (!(o.price > 1)) {
      throw new Error(`devigMarket: invalid decimal price "${o.price}" for outcome "${o.name}" — must be > 1`);
    }
  }

  const raw = outcomes.map((o) => ({ ...o, rawImpliedProbability: 1 / o.price }));
  const overround = raw.reduce((sum, o) => sum + o.rawImpliedProbability, 0);

  return {
    overround,
    outcomes: raw.map((o) => ({
      ...o,
      devigedProbability: o.rawImpliedProbability / overround,
    })),
  };
}

/** Convenience for the common two-outcome case (over/under, BTTS yes/no, etc.). */
export function devigTwoWay(priceA: number, priceB: number): { probA: number; probB: number; overround: number } {
  const { overround, outcomes } = devigMarket([
    { name: "A", price: priceA },
    { name: "B", price: priceB },
  ]);
  return { probA: outcomes[0].devigedProbability, probB: outcomes[1].devigedProbability, overround };
}
