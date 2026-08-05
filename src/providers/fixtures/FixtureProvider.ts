/**
 * Provider-agnostic contract for "which events exist" — decoupled from
 * odds entirely (added 2026-08-03, restoring what this app's own existing
 * comments already described as the intended architecture — see
 * espnLeagueMap.ts's file header referencing "EspnFixtureProvider", and
 * oddsIngestion.ts's "there's no separate fixture-only source anymore",
 * both written before this file existed). The immediate trigger: The Odds
 * API got blocked at the network level (Zscaler content-category filter
 * on api.the-odds-api.com specifically — confirmed live, not an app bug),
 * and since fixture creation was fully coupled to it, that one blocked
 * domain meant zero new fixtures at all, not just missing odds.
 */

export interface NormalizedFixture {
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string; // ISO 8601
}

export interface FixtureProvider {
  readonly name: string;

  /**
   * Fixtures for a sport, bounded to whatever window the provider itself
   * considers "current" (see EspnFixtureProvider — today only, matching
   * this app's existing ingestion window). Returns an empty array for a
   * sport the provider doesn't cover or that genuinely has nothing
   * scheduled right now — a quiet league isn't a failure. A genuine
   * fetch/parse error THROWS instead (changed 2026-08-04) so the caller
   * (fixtureIngestion.ts) can tell "nothing scheduled" apart from "the
   * request failed" when deciding what counts as a source failure — the
   * two used to be indistinguishable, which caused a real empty-calendar
   * day to be recorded as a failure toward the 3-strike auto-disable.
   */
  fetchFixturesForSport(sportKey: string): Promise<NormalizedFixture[]>;
}
