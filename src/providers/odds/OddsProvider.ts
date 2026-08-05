/**
 * Provider-agnostic contract for anything that can supply fixtures + odds.
 *
 * Why an interface: sports odds vendors (The Odds API, Betfair, Pinnacle,
 * proprietary bookmaker feeds, etc.) all shape their data differently. Every
 * part of this app downstream of ingestion (DB writes, agent prompts, the
 * dashboard) only ever sees this normalized shape, so swapping or adding a
 * vendor means writing one new class here — nothing else changes.
 */

export interface OddsOutcome {
  name: string; // e.g. team name, or "Over"/"Under"
  price: number; // decimal odds
  point?: number; // line for spreads/totals, e.g. 2.5
}

export interface OddsMarket {
  marketType: string; // "h2h" | "spreads" | "totals" | ...
  bookmaker: string;
  outcomes: OddsOutcome[];
}

export interface NormalizedEvent {
  externalId: string;
  sportKey: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string; // ISO 8601
  markets: OddsMarket[];
}

export interface ScoreResult {
  externalId: string;
  completed: boolean;
  homeScore: number | null;
  awayScore: number | null;
}

export interface OddsProvider {
  /** Human-readable name, used in logs. */
  readonly name: string;

  /**
   * Fetch events + current odds for a given sport key, restricted to the
   * requested market types and (if the provider supports server-side date
   * filtering — The Odds API does, via commenceTimeFrom/commenceTimeTo) a
   * commence-time window. Returns an empty array on sports the provider
   * doesn't cover rather than throwing, so one bad sport key doesn't take
   * down the whole poll cycle.
   */
  fetchOdds(sportKey: string, marketTypes: string[], window?: { from: Date; to: Date }): Promise<NormalizedEvent[]>;

  /**
   * List sports the provider currently offers, for the market-manager UI
   * to reconcile against (e.g. flag sports that exist in our catalog but
   * the provider has no active odds for right now).
   */
  listAvailableSportKeys(): Promise<string[]>;

  /**
   * Optional: final-score-only results for recently-completed fixtures
   * (see resultsIngestion.ts). Not every odds vendor exposes this, and
   * where it exists it's typically final score only (no half-time score,
   * no corners/cards) — see TheOddsApiProvider's implementation notes for
   * why this is the FALLBACK result source in this app, not the primary.
   */
  fetchScores?(sportKey: string, daysFrom: number): Promise<ScoreResult[]>;
}
