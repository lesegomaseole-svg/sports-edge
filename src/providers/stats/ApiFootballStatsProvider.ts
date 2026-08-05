/**
 * Team form + standings from https://www.api-football.com (v3,
 * api-sports.io). Runs alongside EspnMatchStatsProvider (corners/cards) —
 * this contributes the result-form/table-position signal instead.
 *
 * Verified live 2026-07-31 against the real account behind API_FOOTBALL_KEY:
 *   - Plan: Free, active until 2027-07-31.
 *   - Quota: 10 requests/minute (x-ratelimit-limit), 100 requests/day
 *     (x-ratelimit-requests-limit) — very tight. This is why standings are
 *     cached in-process per league for CACHE_TTL_MS: a whole competition's
 *     table costs exactly one call and covers every team in it, so
 *     analysing several fixtures in the same league only pays for the
 *     table once per cache window instead of once per team lookup.
 *   - All 20 of this app's tracked leagues (original 10 + 10 added
 *     2026-08-01) ARE present in API-Football's catalogue (confirmed via a
 *     live /leagues call, IDs below) — the broadest coverage of any stats
 *     source here, but see the priority note below for why it's not
 *     always the one actually used.
 *   - IMPORTANT free-plan restriction, confirmed live: the /standings
 *     endpoint rejects the actual current season (2026) with
 *     {"plan":"Free plans do not have access to this season, try from
 *     2022 to 2024."}. So SEASON below is pinned to 2024 — the most
 *     recent season the free plan can read — meaning every summary this
 *     provider returns is that season's FINAL table and FINAL last-5 form
 *     (season ended ~May 2025), not this team's actual current form. The
 *     summary text says so explicitly so the prompt (and the model) don't
 *     mistake it for live form — same anti-bias-grounding spirit as the
 *     rest of analyzeEvent.ts.
 *   - PRIORITY (added 2026-08-01): analyzeEvent.ts now prefers
 *     FootballDataStatsProvider over this one wherever both cover a
 *     league — football-data's data is genuinely current, this one is
 *     capped at a stale season. This provider is only actually called for
 *     a league football-data.org doesn't cover (Europa League, MLS,
 *     Scottish Premiership, Danish Superliga, Argentina, Saudi, Turkey,
 *     Belgium, Mexico, Japan — see FootballDataStatsProvider.ts for its
 *     exact 8-of-20 coverage). When it IS used, analyzeEvent.ts adds an
 *     extra "BACKGROUND CONTEXT ONLY" header on top of this provider's own
 *     in-summary staleness note, so the model gets the caveat twice, once
 *     structurally and once in the data itself.
 *   - BUG FOUND + FIXED 2026-08-01: getStandings() used to take
 *     `standings[0]` unconditionally, assuming the full league table is
 *     always the first group in the response. True for most leagues, but
 *     Danish Superliga and Belgian First Division both split into
 *     Championship/Relegation-round sub-groups partway through the
 *     season, and for those two specifically the FULL table sits at a
 *     LATER index (verified live: Denmark's group 0 was a 6-team
 *     "Championship Round" subset, the real 12-team "Regular Season"
 *     table was at index 2) — so any team only in the relegation group
 *     would have silently failed to resolve. Fixed by picking whichever
 *     group has the most teams instead of always taking index 0 (ties
 *     keep the earlier index — verified correct for Liga MX, which
 *     returns two full-size groups, Clausura then Apertura, and the more
 *     recent one should win).
 *   - Head-to-head: /fixtures/headtohead works on the free plan (the
 *     `last` param does not — {"plan":"Free plans do not have access to
 *     the Last parameter."} — full history is returned unsorted instead),
 *     but the shared StatsProvider interface only takes one team per
 *     call, with no opponent parameter, so there's no fixture to pair it
 *     with here. Skipped for the same reason EspnMatchStatsProvider
 *     doesn't do it either — this app's stats interface is single-team by
 *     design.
 *   - Deliberately NOT wired into oddsIngestion.ts's sufficiency scoring:
 *     that loop runs per new fixture across all 20 leagues, which would
 *     burn through the 100/day budget almost immediately. This provider
 *     is prompt-time only (analyzeEvent.ts), driven by on-demand "Analyse"
 *     clicks, which is a far lower and more predictable call volume.
 */
import axios from "axios";
import { StatsProvider, StatsSnapshot } from "./StatsProvider";

const BASE_URL = "https://v3.football.api-sports.io";
const SEASON = 2024; // most recent season the free plan can read for /standings
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — spend at most 1 call/league/6h, not 1/team lookup

// Verified live via GET /leagues (2026-07-31) — every id below returned a
// matching name+country in the response.
const LEAGUE_ID_BY_SPORT_KEY: Record<string, number> = {
  soccer_epl: 39,
  soccer_spain_la_liga: 140,
  soccer_italy_serie_a: 135,
  soccer_germany_bundesliga: 78,
  soccer_france_ligue_one: 61,
  soccer_uefa_champs_league: 2,
  soccer_uefa_europa_league: 3,
  soccer_portugal_primeira_liga: 94,
  soccer_netherlands_eredivisie: 88,
  soccer_usa_mls: 253,
  // Verified live via GET /leagues (2026-08-01).
  soccer_efl_champ: 40,
  soccer_spl: 179,
  soccer_denmark_superliga: 119,
  soccer_brazil_campeonato: 71,
  soccer_argentina_primera_division: 128, // "Liga Profesional Argentina"
  soccer_saudi_arabia_pro_league: 307,
  soccer_turkey_super_league: 203,
  soccer_belgium_first_div: 144, // "Jupiler Pro League"
  soccer_mexico_ligamx: 262,
  soccer_japan_j_league: 98,
  soccer_norway_eliteserien: 103, // verified live 2026-08-01, single-group standings, no split-stage issue
};

interface StandingRow {
  rank: number;
  team: { id: number; name: string };
  points: number;
  form: string | null;
  all: { played: number; win: number; draw: number; lose: number };
}
interface StandingsResponse {
  response: { league: { standings: StandingRow[][] } }[];
  errors?: Record<string, string> | unknown[];
}

interface CacheEntry {
  expiresAt: number;
  rows: StandingRow[];
}

export class ApiFootballStatsProvider implements StatsProvider {
  readonly name = "api-football";
  private cache = new Map<number, CacheEntry>();

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error("ApiFootballStatsProvider requires API_FOOTBALL_KEY to be set");
    }
  }

  supportsSport(sportKey: string): boolean {
    return sportKey in LEAGUE_ID_BY_SPORT_KEY;
  }

  async fetchTeamStats(teamName: string, sportKey: string): Promise<StatsSnapshot | null> {
    const leagueId = LEAGUE_ID_BY_SPORT_KEY[sportKey];
    if (!leagueId) {
      console.warn(`[ApiFootballStatsProvider] no API-Football league id mapped for sportKey "${sportKey}" — skipping.`);
      return null;
    }

    try {
      const rows = await this.getStandings(leagueId);
      const row = rows.find((r) => r.team.name.toLowerCase() === teamName.toLowerCase());
      if (!row) return null;

      const record = `${row.all.win}W-${row.all.draw}D-${row.all.lose}L`;
      const form = row.form ? row.form.split("").join("-") : "n/a";

      return {
        teamName,
        summary: `${teamName}: [free-plan data — last accessible season, ${SEASON}/${SEASON + 1}, not current form] finished/stood rank ${row.rank} with ${row.points} pts (${record}), last 5 that season: ${form}.`,
        raw: { season: SEASON, leagueId, ...row },
      };
    } catch (err) {
      console.error(`[ApiFootballStatsProvider] fetchTeamStats failed for "${teamName}" (${sportKey}):`, (err as Error).message);
      return null;
    }
  }

  private async getStandings(leagueId: number): Promise<StandingRow[]> {
    const cached = this.cache.get(leagueId);
    if (cached && cached.expiresAt > Date.now()) return cached.rows;

    const { data } = await axios.get<StandingsResponse>(`${BASE_URL}/standings`, {
      headers: { "x-apisports-key": this.apiKey },
      params: { league: leagueId, season: SEASON },
      timeout: 10_000,
    });

    if (data.errors && (Array.isArray(data.errors) ? data.errors.length > 0 : Object.keys(data.errors).length > 0)) {
      console.warn(`[ApiFootballStatsProvider] API error for league ${leagueId}:`, JSON.stringify(data.errors));
      this.cache.set(leagueId, { expiresAt: Date.now() + CACHE_TTL_MS, rows: [] });
      return [];
    }

    // Not always standings[0] — see file header's "BUG FOUND + FIXED" note.
    // The full/regular-season table is the group with the most teams;
    // strict `>` (not `>=`) keeps the earlier index on a tie, which is
    // correct for Liga MX's two full-size Clausura/Apertura groups (the
    // more recent one, Clausura, comes first).
    const groups = data.response[0]?.league.standings ?? [];
    const rows = groups.reduce((largest, group) => (group.length > largest.length ? group : largest), [] as StandingRow[]);
    this.cache.set(leagueId, { expiresAt: Date.now() + CACHE_TTL_MS, rows });
    return rows;
  }
}
