/**
 * Per-match xG (expected goals) for MLS from American Soccer Analysis
 * (americansocceranalysis.com) — genuinely free, no key, no auth, a real
 * JSON API (app.americansocceranalysis.com), not HTML scraping.
 *
 * PERMISSION CHECKED (2026-08-07), same discipline as every other source
 * added this session: robots.txt is a generic Squarespace default — it
 * LISTS many AI crawler names (including ClaudeBot) but with no Disallow
 * of their own, so they fall through to the same `User-agent: *` rules as
 * everyone else, which only block /config, /search, /account, and /api/
 * on the MARKETING site (americansocceranalysis.com) — not the separate
 * data API host (app.americansocceranalysis.com) this provider actually
 * calls. No /terms or /terms-of-service page exists (both 404), no
 * paywall/subscription language anywhere on the site, and their own
 * explainer page invites exactly this use: "all our expected goals data
 * can be found in our interactive tables." Different situation entirely
 * from playerstats.football, which was ruled out the same day for an
 * explicit ToS prohibition on scraping — checked THAT before writing a
 * single line of that one, unlike the mistake of getting partway into
 * page-structure work first.
 *
 * SCOPE: MLS only (soccer_usa_mls) — ASA covers North American soccer
 * (MLS/NWSL/USL) exclusively, confirmed via their own team/league list.
 * Does not help any of this app's other 23 tracked leagues; xG for those
 * remains unavailable (see the broader source-search this same night —
 * Understat/FBref/WhoScored/FotMob/footystats/xGscore all ruled out by
 * explicit block or bot-detection, nothing broader found).
 *
 * NAMING: this app's team names come from ESPN (see espnLeagueMap.ts),
 * which doesn't always match ASA's own naming — confirmed live against
 * ASA's full MLS team list. Suffix/accent differences (e.g. "Vancouver
 * Whitecaps FC" vs ESPN's "Vancouver Whitecaps") are handled by
 * normalize() below; two non-mechanical mismatches needed an explicit
 * alias: "LAFC" (ESPN) has no shared substring with ASA's "Los Angeles
 * FC", and "Red Bull New York" (ESPN) is word-order-flipped from ASA's
 * "New York Red Bulls".
 */
import axios from "axios";
import { StatsProvider, StatsSnapshot } from "./StatsProvider";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — matches other providers; games/xgoals data only changes as matches complete
const RECENT_MATCH_COUNT = 5;
const BASE_URL = "https://app.americansocceranalysis.com/api/v1/mls";
const SUPPORTED_SPORT_KEY = "soccer_usa_mls";

// ESPN name (lowercase, this provider's normalize()) -> ASA's real team_name.
const NAME_ALIASES: Record<string, string> = {
  lafc: "Los Angeles FC",
  "redbullnewyork": "New York Red Bulls",
};

interface AsaTeam {
  team_id: string;
  team_name: string;
}
interface AsaGameXg {
  game_id: string;
  date_time_utc: string;
  home_team_id: string;
  away_team_id: string;
  home_goals: number;
  away_goals: number;
  home_team_xgoals: number;
  away_team_xgoals: number;
}

interface CacheEntry<T> {
  expiresAt: number;
  data: T | null;
}
let teamsCache: CacheEntry<AsaTeam[]> | null = null;
let gamesCache: CacheEntry<AsaGameXg[]> | null = null;

function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|sc)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export class AmericanSoccerAnalysisProvider implements StatsProvider {
  readonly name = "american-soccer-analysis";

  supportsSport(sportKey: string): boolean {
    return sportKey === SUPPORTED_SPORT_KEY;
  }

  async fetchTeamStats(teamName: string, sportKey: string): Promise<StatsSnapshot | null> {
    if (sportKey !== SUPPORTED_SPORT_KEY) return null;

    const teams = await this.getTeams();
    if (!teams) return null;

    const target = normalize(teamName);
    const aliasTarget = NAME_ALIASES[target] ? normalize(NAME_ALIASES[target]) : null;
    const team = teams.find((t) => {
      const n = normalize(t.team_name);
      return n === target || (aliasTarget != null && n === aliasTarget);
    });
    if (!team) {
      return { teamName, summary: `${teamName}: not resolved on American Soccer Analysis (name mismatch or not an MLS team).` };
    }

    const games = await this.getGames();
    if (!games) return null;

    const teamGames = games
      .filter((g) => g.home_team_id === team.team_id || g.away_team_id === team.team_id)
      .sort((a, b) => new Date(a.date_time_utc).getTime() - new Date(b.date_time_utc).getTime())
      .slice(-RECENT_MATCH_COUNT)
      .reverse();

    if (teamGames.length === 0) {
      return { teamName, summary: `${teamName}: resolved on American Soccer Analysis but no recent match data available.` };
    }

    const lines = teamGames.map((g) => {
      const isHome = g.home_team_id === team.team_id;
      const gf = isHome ? g.home_goals : g.away_goals;
      const ga = isHome ? g.away_goals : g.home_goals;
      const xgf = isHome ? g.home_team_xgoals : g.away_team_xgoals;
      const xga = isHome ? g.away_team_xgoals : g.home_team_xgoals;
      const outcome = gf > ga ? "W" : gf < ga ? "L" : "D";
      return `${outcome}(${gf}-${ga}, xG ${xgf.toFixed(2)}-${xga.toFixed(2)})`;
    });

    const avgXgFor = teamGames.reduce((sum, g) => sum + (g.home_team_id === team.team_id ? g.home_team_xgoals : g.away_team_xgoals), 0) / teamGames.length;
    const avgXgAgainst = teamGames.reduce((sum, g) => sum + (g.home_team_id === team.team_id ? g.away_team_xgoals : g.home_team_xgoals), 0) / teamGames.length;

    return {
      teamName,
      summary: `${teamName}: last ${teamGames.length} (American Soccer Analysis): ${lines.join(" ")} — avg ${avgXgFor.toFixed(2)} xG for, ${avgXgAgainst.toFixed(2)} xG against per game.`,
      raw: { matchCount: teamGames.length, avgXgFor, avgXgAgainst },
    };
  }

  private async getTeams(): Promise<AsaTeam[] | null> {
    if (teamsCache && teamsCache.expiresAt > Date.now()) return teamsCache.data;
    try {
      const { data } = await axios.get<AsaTeam[]>(`${BASE_URL}/teams`, { timeout: 10_000 });
      teamsCache = { expiresAt: Date.now() + CACHE_TTL_MS, data };
      return data;
    } catch (err) {
      console.error(`[AmericanSoccerAnalysisProvider] fetching teams failed:`, (err as Error).message);
      teamsCache = { expiresAt: Date.now() + CACHE_TTL_MS, data: null };
      return null;
    }
  }

  private async getGames(): Promise<AsaGameXg[] | null> {
    if (gamesCache && gamesCache.expiresAt > Date.now()) return gamesCache.data;
    try {
      const { data } = await axios.get<AsaGameXg[]>(`${BASE_URL}/games/xgoals`, { timeout: 10_000 });
      gamesCache = { expiresAt: Date.now() + CACHE_TTL_MS, data };
      return data;
    } catch (err) {
      console.error(`[AmericanSoccerAnalysisProvider] fetching games failed:`, (err as Error).message);
      gamesCache = { expiresAt: Date.now() + CACHE_TTL_MS, data: null };
      return null;
    }
  }
}
