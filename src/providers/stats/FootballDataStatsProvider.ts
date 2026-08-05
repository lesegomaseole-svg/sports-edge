/**
 * Team form + standings from https://www.football-data.org (v4). Runs
 * alongside EspnMatchStatsProvider (corners/cards) and ApiFootballStatsProvider
 * — a second, independent take on the same result-form/table-position
 * signal, from a source with materially better league coverage and fresher
 * data than API-Football's free plan.
 *
 * Verified live 2026-07-31 (original 10 leagues) and re-checked 2026-08-01
 * (10 more added) against the real account behind FOOTBALL_DATA_API_KEY:
 *   - Quota: X-RequestCounter-Reset/x-requests-available-minute headers
 *     confirm 10 requests/minute on the free plan. No documented daily cap
 *     was observed (unlike API-Football's 100/day).
 *   - League coverage: a live GET /v4/competitions call returned 13
 *     competitions total, unchanged between the two checks — covering 8
 *     of this app's 20 tracked leagues — PL, PD (La Liga), SA, BL1
 *     (Bundesliga), FL1 (Ligue 1), CL, PPL, DED, plus (added 2026-08-01)
 *     ELC (English Championship) and BSA (Brazilian Série A). NOT
 *     covered, confirmed genuinely absent from the free-plan list (not a
 *     lookup miss): UEFA Europa League, MLS, Scottish Premiership, Danish
 *     Superliga, Argentina, Saudi Arabia, Turkey, Belgium, Mexico, Japan.
 *     Those sportKeys are simply skipped here (logged, not faked) — see
 *     ApiFootballStatsProvider/SportMonksStatsProvider for what covers them
 *     instead.
 *   - PRIORITY (added 2026-08-01): analyzeEvent.ts now prefers THIS
 *     provider over ApiFootballStatsProvider wherever both cover a
 *     league, since this data is genuinely current and API-Football's
 *     free plan is capped at a stale season — see supportsSport() below,
 *     which analyzeEvent.ts checks before deciding whether to call
 *     ApiFootballStatsProvider at all for a given league.
 *   - Standings' own `form` field came back null on the general
 *     standings call (a known quirk of this endpoint), so recent form is
 *     computed here instead from each team's last 5 FINISHED matches —
 *     genuinely current: verified live results ran up to 2026-05-30, ~2
 *     months before this app's "now".
 *   - Season handling: /teams/{id}/matches defaults to the CURRENT
 *     season pointer, which for competitions between seasons (as of
 *     writing, PL's pointer had already rolled to 2026-27, not yet
 *     started) returns zero matches. Mirrors EspnMatchStatsProvider's
 *     fallback: try the current year's season, then the previous year's,
 *     first one with completed matches wins.
 *   - Head-to-head: skipped for the same reason as ApiFootballStatsProvider
 *     — StatsProvider.fetchTeamStats only receives one team, with no
 *     opponent parameter to pair a head-to-head query against.
 *   - Not wired into oddsIngestion.ts's sufficiency scoring, same
 *     reasoning as ApiFootballStatsProvider: that loop runs per new
 *     fixture across every tracked league, and this provider is meant for
 *     on-demand analyzeEvent.ts calls, not a tight automated loop.
 */
import axios from "axios";
import { StatsProvider, StatsSnapshot } from "./StatsProvider";

const BASE_URL = "https://api.football-data.org/v4";
const STANDINGS_CACHE_TTL_MS = 3 * 60 * 60 * 1000; // 3h — one call covers every team in the competition
const RECENT_MATCH_COUNT = 5;

// Verified live via GET /v4/competitions (2026-07-31).
const COMPETITION_CODE_BY_SPORT_KEY: Record<string, string> = {
  soccer_epl: "PL",
  soccer_spain_la_liga: "PD",
  soccer_italy_serie_a: "SA",
  soccer_germany_bundesliga: "BL1",
  soccer_france_ligue_one: "FL1",
  soccer_uefa_champs_league: "CL",
  soccer_portugal_primeira_liga: "PPL",
  soccer_netherlands_eredivisie: "DED",
  soccer_efl_champ: "ELC",
  soccer_brazil_campeonato: "BSA",
  // Confirmed NOT on the free-plan competition list (checked 2026-08-01):
  // soccer_uefa_europa_league, soccer_usa_mls, soccer_spl,
  // soccer_denmark_superliga, soccer_argentina_primera_division,
  // soccer_saudi_arabia_pro_league, soccer_turkey_super_league,
  // soccer_belgium_first_div, soccer_mexico_ligamx, soccer_japan_j_league.
};

interface StandingRow {
  position: number;
  team: { id: number; name: string };
  playedGames: number;
  points: number;
  won: number;
  draw: number;
  lost: number;
}
interface StandingsResponse {
  standings: { type: string; table: StandingRow[] }[];
}
interface MatchTeamRef {
  id: number;
  shortName?: string;
  name?: string;
}
interface MatchScore {
  fullTime: { home: number | null; away: number | null };
}
interface Match {
  utcDate: string;
  homeTeam: MatchTeamRef;
  awayTeam: MatchTeamRef;
  score: MatchScore;
}
interface MatchesResponse {
  matches: Match[];
}

interface StandingsCacheEntry {
  expiresAt: number;
  rows: StandingRow[];
}

export class FootballDataStatsProvider implements StatsProvider {
  readonly name = "football-data";
  private standingsCache = new Map<string, StandingsCacheEntry>();

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error("FootballDataStatsProvider requires FOOTBALL_DATA_API_KEY to be set");
    }
  }

  supportsSport(sportKey: string): boolean {
    return sportKey in COMPETITION_CODE_BY_SPORT_KEY;
  }

  async fetchTeamStats(teamName: string, sportKey: string): Promise<StatsSnapshot | null> {
    const competitionCode = COMPETITION_CODE_BY_SPORT_KEY[sportKey];
    if (!competitionCode) {
      console.warn(`[FootballDataStatsProvider] no football-data.org competition mapped for sportKey "${sportKey}" — skipping.`);
      return null;
    }

    try {
      const rows = await this.getStandings(competitionCode);
      const row = rows.find((r) => r.team.name.toLowerCase() === teamName.toLowerCase() || r.team.name.toLowerCase().includes(teamName.toLowerCase()));
      if (!row) return null;

      const recentMatches = await this.recentFinishedMatches(row.team.id);
      const formPart =
        recentMatches.length > 0
          ? `last ${recentMatches.length}: ${recentMatches.map((r) => this.resultLetter(r, row.team.id)).join("-")}`
          : "recent form unavailable";

      return {
        teamName,
        summary: `${teamName}: ${competitionCode} table position ${row.position}/${rows.length}, ${row.points} pts (${row.won}W-${row.draw}D-${row.lost}L, ${row.playedGames} played), ${formPart}.`,
        raw: { competitionCode, ...row, recentMatches },
      };
    } catch (err) {
      console.error(`[FootballDataStatsProvider] fetchTeamStats failed for "${teamName}" (${sportKey}):`, (err as Error).message);
      return null;
    }
  }

  private resultLetter(m: Match, teamId: number): string {
    const isHome = m.homeTeam.id === teamId;
    const own = isHome ? m.score.fullTime.home : m.score.fullTime.away;
    const opp = isHome ? m.score.fullTime.away : m.score.fullTime.home;
    if (own == null || opp == null) return "?";
    if (own > opp) return "W";
    if (own < opp) return "L";
    return "D";
  }

  private async getStandings(competitionCode: string): Promise<StandingRow[]> {
    const cached = this.standingsCache.get(competitionCode);
    if (cached && cached.expiresAt > Date.now()) return cached.rows;

    const { data } = await axios.get<StandingsResponse>(`${BASE_URL}/competitions/${competitionCode}/standings`, {
      headers: { "X-Auth-Token": this.apiKey },
      timeout: 10_000,
    });

    const rows = data.standings.find((s) => s.type === "TOTAL")?.table ?? data.standings[0]?.table ?? [];
    this.standingsCache.set(competitionCode, { expiresAt: Date.now() + STANDINGS_CACHE_TTL_MS, rows });
    return rows;
  }

  private async recentFinishedMatches(teamId: number): Promise<Match[]> {
    const currentYear = new Date().getUTCFullYear();

    for (const season of [currentYear, currentYear - 1]) {
      const { data } = await axios.get<MatchesResponse>(`${BASE_URL}/teams/${teamId}/matches`, {
        headers: { "X-Auth-Token": this.apiKey },
        params: { status: "FINISHED", season },
        timeout: 10_000,
      });

      const sorted = [...(data.matches ?? [])].sort((a, b) => new Date(b.utcDate).getTime() - new Date(a.utcDate).getTime());
      if (sorted.length > 0) return sorted.slice(0, RECENT_MATCH_COUNT);
    }

    return [];
  }
}
