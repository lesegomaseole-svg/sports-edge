/**
 * Team form/standings from https://www.sportmonks.com (Football v3 API).
 * Intended to run alongside EspnMatchStatsProvider, ApiFootballStatsProvider,
 * and FootballDataStatsProvider.
 *
 * ⚠️ CONFIRMED LIVE 2026-07-31, WITH REAL AUTH: this app's free-plan
 * SportMonks account has usable coverage of exactly 4 football leagues —
 * Danish Superliga (id 271) + its play-offs (1659), and Scottish
 * Premiership (id 501) + its play-offs (513) — confirmed three separate
 * ways (GET /football/leagues unpaginated list, GET /football/my/leagues
 * subscription-scoped list, and a direct team-name search that 403'd for
 * an out-of-plan team). Of THIS app's 20 tracked leagues, that means
 * usable coverage of exactly 2: Scottish Premiership (soccer_spl) and
 * Danish Superliga (soccer_denmark_superliga), added 2026-08-01. Every
 * other league here still returns nothing on this plan — not a bug, a
 * real plan-tier limitation, same as before for those leagues.
 *
 * VERIFIED END-TO-END 2026-08-01 once real coverage existed to test
 * against: searched "Celtic" (Scottish Premiership) -> got a real team id
 * -> fetched `latest.scores;latest.participants` -> got 40 real recent
 * fixtures with genuine scores (e.g. "Celtic won after full-time.", 3-1,
 * 2026-05-16). This also caught and fixed a real bug in resultLetter()
 * below — see its comment.
 *
 * Rate limit (confirmed live via response body's `rate_limit` object,
 * not just headers): 3000 requests, resetting every 3600s — i.e.
 * 3000/hour.
 *
 * No static per-sportKey coverage map exists for this provider (unlike
 * ApiFootballStatsProvider/FootballDataStatsProvider) because coverage
 * here is a whole-account subscription entitlement, not something
 * knowable from a sportKey alone — every call is a genuine attempt, and
 * DataSourceHealth's normal 3-strikes tracking is what actually reflects
 * this provider's real-world reliability (see StatsProvider.supportsSport's
 * doc comment for why this provider intentionally omits it).
 *
 * Head-to-head: not implemented, same reason as the other two new stats
 * providers — StatsProvider.fetchTeamStats takes one team, no opponent.
 * Not wired into oddsIngestion.ts sufficiency scoring — prompt-time only
 * (analyzeEvent.ts), consistent with ApiFootballStatsProvider/
 * FootballDataStatsProvider.
 */
import axios from "axios";
import { StatsProvider, StatsSnapshot } from "./StatsProvider";

const BASE_URL = "https://api.sportmonks.com/v3/football";
const RECENT_MATCH_COUNT = 5;

interface TeamSearchResult {
  id: number;
  name: string;
}
interface TeamSearchResponse {
  data: TeamSearchResult[];
}
interface FixtureParticipant {
  id: number;
  meta?: { location?: "home" | "away" };
}
interface FixtureScore {
  participant_id: number;
  score?: { goals?: number };
  description?: string; // e.g. "CURRENT" / "FT"
}
interface Fixture {
  starting_at: string;
  participants?: FixtureParticipant[];
  scores?: FixtureScore[];
}
interface TeamDetailResponse {
  data: { id: number; name: string; latest?: Fixture[] };
}

export class SportMonksStatsProvider implements StatsProvider {
  readonly name = "sportmonks";

  constructor(private readonly apiToken: string) {
    if (!apiToken) {
      throw new Error("SportMonksStatsProvider requires SPORTMONKS_API_KEY to be set");
    }
  }

  async fetchTeamStats(teamName: string, _sportKey: string): Promise<StatsSnapshot | null> {
    try {
      const team = await this.searchTeam(teamName);
      if (!team) return null; // expected outcome today — see file header.

      const { data } = await axios.get<TeamDetailResponse>(`${BASE_URL}/teams/${team.id}`, {
        params: { api_token: this.apiToken, include: "latest.scores;latest.participants" },
        timeout: 10_000,
      });

      const recent = (data.data.latest ?? [])
        .sort((a, b) => new Date(b.starting_at).getTime() - new Date(a.starting_at).getTime())
        .slice(0, RECENT_MATCH_COUNT);

      if (recent.length === 0) {
        return { teamName, summary: `${teamName}: resolved on SportMonks but no recent fixture data available.` };
      }

      const form = recent.map((f) => this.resultLetter(f, team.id)).join("-");
      return {
        teamName,
        summary: `${teamName}: last ${recent.length} (SportMonks): ${form}.`,
        raw: { teamId: team.id, recent },
      };
    } catch (err) {
      console.error(`[SportMonksStatsProvider] fetchTeamStats failed for "${teamName}":`, (err as Error).message);
      return null;
    }
  }

  // BUG FOUND + FIXED 2026-08-01 (once real data existed to test against —
  // Scottish Premiership/Danish Superliga are the only entitled leagues,
  // see file header): `scores` holds several rows per team per fixture
  // (1ST_HALF, 2ND_HALF, 2ND_HALF_ONLY, CURRENT, ...) — 2ND_HALF happens
  // to equal the final score for a completed match, so blindly taking the
  // FIRST match by participant_id worked by coincidence in initial
  // testing, but isn't guaranteed by SportMonks' array ordering. Filter
  // explicitly for description === "CURRENT" (the actual final/cumulative
  // score) instead.
  private resultLetter(f: Fixture, teamId: number): string {
    const me = f.scores?.find((s) => s.participant_id === teamId && s.description === "CURRENT")?.score?.goals;
    const opp = f.scores?.find((s) => s.participant_id !== teamId && s.description === "CURRENT")?.score?.goals;
    if (me == null || opp == null) return "?";
    if (me > opp) return "W";
    if (me < opp) return "L";
    return "D";
  }

  private async searchTeam(teamName: string): Promise<TeamSearchResult | null> {
    const { data } = await axios.get<TeamSearchResponse>(`${BASE_URL}/teams/search/${encodeURIComponent(teamName)}`, {
      params: { api_token: this.apiToken },
      timeout: 10_000,
    });
    return data.data?.[0] ?? null;
  }
}
