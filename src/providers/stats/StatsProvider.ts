/**
 * Provider-agnostic contract for team statistics sources. Same pattern as
 * OddsProvider/NewsProvider. Wired into the agent prompt in
 * src/lib/analyzeEvent.ts via EspnStatsProvider (real, no key required —
 * see espnLeagueMap.ts for sport coverage).
 */

export interface StatsSnapshot {
  teamName: string;
  summary: string; // human-readable text, suitable for an agent prompt
  raw?: Record<string, unknown>;
}

export interface StatsProvider {
  readonly name: string;
  fetchTeamStats(teamName: string, sportKey: string): Promise<StatsSnapshot | null>;
  /**
   * Optional: for providers with a STATIC, known-in-advance per-sportKey
   * coverage map (e.g. ApiFootballStatsProvider, FootballDataStatsProvider),
   * lets callers skip a sportKey they already know isn't covered — without
   * this, "not covered" and "covered but this call returned nothing" both
   * come back as fetchTeamStats() -> null, which is indistinguishable, and
   * DataSourceHealth would wrongly count a permanent coverage gap the same
   * as a real, retry-worthy failure (see analyzeEvent.ts's use of this).
   * Omit entirely for providers whose coverage can only be known by
   * actually calling the API (e.g. SportMonksStatsProvider, which resolves
   * teams by name search) — there, every call is a genuine attempt.
   */
  supportsSport?(sportKey: string): boolean;
}
