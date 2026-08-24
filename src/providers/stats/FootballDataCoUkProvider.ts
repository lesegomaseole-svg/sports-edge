/**
 * Match results/stats from football-data.co.uk — a genuinely open CSV data
 * site (no key, no auth, no bot-blocking), distinct from football-data.org
 * (FootballDataStatsProvider.ts, a different site entirely despite the
 * similar name).
 *
 * ROBOTS.TXT CHECKED FIRST (2026-08-07), per this app's own established
 * discipline (see worldfootball.net's rejection, and the SofaScore/
 * fotmob.com/understat.com/whoscored.com checks the same day): confirmed
 * live — `Disallow:` (empty) for `User-agent: *`, i.e. full access, no
 * restriction. Also confirmed live that the site's own infrastructure
 * doesn't bot-block the way SofaScore/WhoScored do — plain curl, no
 * special headers, clean 200s throughout.
 *
 * COVERAGE — two genuinely different data depths, verified live per
 * league (not assumed from documentation), matched against this app's own
 * 24 tracked sportKeys:
 *   - RICH (mmz4281/{season}/{code}.csv — season-specific file, one of
 *     11 "traditional" European nations): full box score — shots, shots
 *     on target, fouls, corners, cards, referee, on top of goals/result.
 *   - THIN (new/{code}.csv — one continuous rolling file per country,
 *     not season-specific): goals, result, and historical bookmaker odds
 *     ONLY — no corners/cards/fouls/shots at all. This is most of what
 *     this app actually analyses day to day (Argentina, MLS, Liga MX,
 *     Brazil, Denmark, Norway).
 *   - NOT COVERED at all: every continental competition (Champions/
 *     Europa/Conference League and their qualifying rounds — confirmed
 *     live, this site is domestic-leagues-only), Saudi Arabia (no file),
 *     and Japan (a file exists but its most recent match was 2025-12-06 —
 *     months stale, deliberately excluded rather than served as if current).
 * See LEAGUE_MAP below for the exact per-league verified mapping.
 *
 * SEASON HANDLING: the RICH path is season-specific
 * (mmz4281/{season}/{code}.csv), and the new 2026/27 season's files don't
 * exist yet as of this writing (confirmed live: HTTP 404) — the big
 * European leagues haven't started their new season, consistent with
 * this app's own D3 finding that early August is a genuine off-period for
 * most of them. currentSeasonCode()/previousSeasonCode() below compute
 * both candidates and this provider tries current-first, falling back to
 * previous — so it picks up the new season automatically once real
 * fixtures exist there, with no manual yearly update needed. The THIN
 * path has no season component at all (one rolling file per country,
 * confirmed live: contains matches from 2012 through today in one file).
 */
import axios from "axios";
import { StatsProvider, StatsSnapshot } from "./StatsProvider";
import { TeamGoalProfile, LeagueAverages } from "../../lib/poissonModel";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — the file only changes as matches complete, no need to re-fetch more often
const RECENT_MATCH_COUNT = 5;
const BASE_URL = "https://www.football-data.co.uk";

// See getLeagueTeamRates below for why this exists.
const MIN_MATCHES_FOR_RATE = 5;

export interface TeamGoalProfileWithMeta extends TeamGoalProfile {
  matchCount: number;
}

export interface LeagueTeamRates {
  league: LeagueAverages;
  home: Map<string, TeamGoalProfileWithMeta>; // keyed by the team name as it appears in this source's own CSV
  away: Map<string, TeamGoalProfileWithMeta>;
}

interface LeagueRef {
  code: string;
  path: "mmz4281" | "new";
  rich: boolean;
}

// Verified live 2026-08-07: every code below returned a real 200 CSV whose
// content (team names, country) was checked against the expected league,
// not assumed from the code alone (e.g. this caught D1 being Germany, not
// Denmark, before it went into this map wrong).
const LEAGUE_MAP: Record<string, LeagueRef> = {
  soccer_epl: { code: "E0", path: "mmz4281", rich: true },
  soccer_efl_champ: { code: "E1", path: "mmz4281", rich: true },
  soccer_spl: { code: "SC0", path: "mmz4281", rich: true },
  soccer_germany_bundesliga: { code: "D1", path: "mmz4281", rich: true },
  soccer_italy_serie_a: { code: "I1", path: "mmz4281", rich: true },
  soccer_spain_la_liga: { code: "SP1", path: "mmz4281", rich: true },
  soccer_france_ligue_one: { code: "F1", path: "mmz4281", rich: true },
  soccer_netherlands_eredivisie: { code: "N1", path: "mmz4281", rich: true },
  soccer_belgium_first_div: { code: "B1", path: "mmz4281", rich: true },
  soccer_portugal_primeira_liga: { code: "P1", path: "mmz4281", rich: true },
  soccer_turkey_super_league: { code: "T1", path: "mmz4281", rich: true },
  soccer_argentina_primera_division: { code: "ARG", path: "new", rich: false },
  soccer_usa_mls: { code: "USA", path: "new", rich: false },
  soccer_mexico_ligamx: { code: "MEX", path: "new", rich: false },
  soccer_brazil_campeonato: { code: "BRA", path: "new", rich: false },
  soccer_denmark_superliga: { code: "DNK", path: "new", rich: false },
  soccer_norway_eliteserien: { code: "NOR", path: "new", rich: false },
};

function seasonCode(offsetYears: number): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12
  // European season runs Aug-May; before August we're still in the season
  // that started the previous calendar year.
  const currentStartYear = (month >= 8 ? year : year - 1) + offsetYears;
  const endYear = currentStartYear + 1;
  return `${String(currentStartYear).slice(-2)}${String(endYear).slice(-2)}`;
}

export interface ParsedMatch {
  date: string;
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
  result: string;
  homeCorners?: number;
  awayCorners?: number;
  homeYellow?: number;
  awayYellow?: number;
  homeFouls?: number;
  awayFouls?: number;
  homeShots?: number;
  awayShots?: number;
  referee?: string;
}

interface CacheEntry {
  expiresAt: number;
  matches: ParsedMatch[] | null; // null = fetch failed this window, don't retry until it expires
}
const fileCache = new Map<string, CacheEntry>();

// Minimal CSV line splitter — safe for this data specifically because
// team/referee names here never contain commas (checked across every
// league fetched during verification); a general CSV parser (quoted
// fields, escaped commas) is unneeded complexity for this source.
function splitCsvLine(line: string): string[] {
  return line.split(",").map((c) => c.trim());
}

function parseCsv(text: string, rich: boolean): ParsedMatch[] {
  // Strip a leading BOM — confirmed present on every file from this site.
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const header = splitCsvLine(lines[0]);
  const col = (name: string) => header.indexOf(name);

  const dateCol = col("Date");
  const homeCol = rich ? col("HomeTeam") : col("Home");
  const awayCol = rich ? col("AwayTeam") : col("Away");
  const hgCol = rich ? col("FTHG") : col("HG");
  const agCol = rich ? col("FTAG") : col("AG");
  const resCol = rich ? col("FTR") : col("Res");
  const hsCol = col("HS");
  const asCol = col("AS");
  const hfCol = col("HF");
  const afCol = col("AF");
  const hcCol = col("HC");
  const acCol = col("AC");
  const hyCol = col("HY");
  const ayCol = col("AY");
  const refCol = col("Referee");

  if (homeCol === -1 || awayCol === -1) return []; // header shape unrecognized — safe-fail to empty, not a crash

  const num = (row: string[], i: number): number | undefined => {
    if (i === -1) return undefined;
    const v = Number(row[i]);
    return Number.isFinite(v) ? v : undefined;
  };

  const matches: ParsedMatch[] = [];
  for (const line of lines.slice(1)) {
    const row = splitCsvLine(line);
    if (row.length < header.length - 2) continue; // defensive: skip malformed/short rows rather than throw
    const home = row[homeCol];
    const away = row[awayCol];
    if (!home || !away) continue;
    matches.push({
      date: dateCol !== -1 ? row[dateCol] : "",
      home,
      away,
      homeGoals: num(row, hgCol) ?? 0,
      awayGoals: num(row, agCol) ?? 0,
      result: resCol !== -1 ? row[resCol] : "",
      homeCorners: num(row, hcCol),
      awayCorners: num(row, acCol),
      homeYellow: num(row, hyCol),
      awayYellow: num(row, ayCol),
      homeFouls: num(row, hfCol),
      awayFouls: num(row, afCol),
      homeShots: num(row, hsCol),
      awayShots: num(row, asCol),
      referee: refCol !== -1 ? row[refCol] : undefined,
    });
  }
  return matches;
}

// Accent/case-insensitive fallback for team names that don't exact-match —
// this app's team names come from ESPN (see espnLeagueMap.ts), which
// doesn't always agree with football-data.co.uk's own naming (e.g. ESPN's
// "Belgrano (Córdoba)" vs this site's plain "Belgrano"). Deliberately
// simpler than espnLeagueMap.ts's normalizeForMatch (no suffix-stripping
// aliases) — kept as a smaller, separate function since this source's
// naming quirks aren't the same ones that function was built for.
export function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// A team matches if EITHER its full normalized name matches, OR its
// normalized name with a trailing "(City)" qualifier stripped does \u2014 added
// after "Belgrano (C\u00f3rdoba)" (ESPN's name, what this app actually stores)
// failed to match this source's plain "Belgrano". Confirmed live this
// pattern recurs across several Argentine clubs (Talleres, Central
// C\u00f3rdoba, Gimnasia, Instituto all use the same ESPN "Club (City)" shape).
export function normalizeVariants(name: string): string[] {
  const variants = [normalize(name)];
  const withoutParen = name.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (withoutParen !== name) variants.push(normalize(withoutParen));
  return variants;
}

/**
 * Pure aggregation, deliberately separate from getLeagueTeamRates' network
 * fetch (added 2026-08-24) — this is the part that can actually have a
 * logic bug, so it needs to be testable with a synthetic, hand-computable
 * dataset independent of whether the live CSV fetch is reachable on any
 * given network. Same "pure computation, separate from I/O" split already
 * used for src/lib/poissonModel.ts and src/lib/devig.ts.
 */
export function aggregateTeamRates(matches: ParsedMatch[]): LeagueTeamRates | null {
  if (matches.length === 0) return null;

  let totalHomeGoals = 0;
  let totalAwayGoals = 0;
  const homeAgg = new Map<string, { goalsFor: number; goalsAgainst: number; count: number }>();
  const awayAgg = new Map<string, { goalsFor: number; goalsAgainst: number; count: number }>();

  for (const m of matches) {
    totalHomeGoals += m.homeGoals;
    totalAwayGoals += m.awayGoals;

    const h = homeAgg.get(m.home) ?? { goalsFor: 0, goalsAgainst: 0, count: 0 };
    h.goalsFor += m.homeGoals;
    h.goalsAgainst += m.awayGoals;
    h.count += 1;
    homeAgg.set(m.home, h);

    const a = awayAgg.get(m.away) ?? { goalsFor: 0, goalsAgainst: 0, count: 0 };
    a.goalsFor += m.awayGoals;
    a.goalsAgainst += m.homeGoals;
    a.count += 1;
    awayAgg.set(m.away, a);
  }

  const avgHomeGoals = totalHomeGoals / matches.length;
  const avgAwayGoals = totalAwayGoals / matches.length;
  const league: LeagueAverages = { avgHomeGoals, avgAwayGoals };

  const home = new Map<string, TeamGoalProfileWithMeta>();
  for (const [team, agg] of homeAgg) {
    if (agg.count < MIN_MATCHES_FOR_RATE) continue;
    home.set(team, {
      attackStrength: agg.goalsFor / agg.count / avgHomeGoals,
      defenseWeakness: agg.goalsAgainst / agg.count / avgAwayGoals,
      matchCount: agg.count,
    });
  }

  const away = new Map<string, TeamGoalProfileWithMeta>();
  for (const [team, agg] of awayAgg) {
    if (agg.count < MIN_MATCHES_FOR_RATE) continue;
    away.set(team, {
      attackStrength: agg.goalsFor / agg.count / avgAwayGoals,
      defenseWeakness: agg.goalsAgainst / agg.count / avgHomeGoals,
      matchCount: agg.count,
    });
  }

  return { league, home, away };
}

export class FootballDataCoUkProvider implements StatsProvider {
  readonly name = "football-data-co-uk";

  supportsSport(sportKey: string): boolean {
    return sportKey in LEAGUE_MAP;
  }

  async fetchTeamStats(teamName: string, sportKey: string): Promise<StatsSnapshot | null> {
    const ref = LEAGUE_MAP[sportKey];
    if (!ref) return null;

    const matches = await this.getLeagueMatches(ref);
    if (!matches) return null;

    const targetVariants = normalizeVariants(teamName);
    const isTarget = (name: string) => targetVariants.includes(normalize(name));
    const teamMatches = matches
      .filter((m) => isTarget(m.home) || isTarget(m.away))
      .slice(-RECENT_MATCH_COUNT)
      .reverse(); // file is chronological; most recent last, so reverse for "most recent first"

    if (teamMatches.length === 0) {
      return { teamName, summary: `${teamName}: not resolved on football-data.co.uk for this league (name mismatch or no recorded matches).` };
    }

    const seasonNote = ref.rich
      ? " — most recent completed matches, may be last season's form if the new season hasn't started fixtures yet"
      : "";
    const form = teamMatches
      .map((m) => {
        const isHome = isTarget(m.home);
        const gf = isHome ? m.homeGoals : m.awayGoals;
        const ga = isHome ? m.awayGoals : m.homeGoals;
        const outcome = gf > ga ? "W" : gf < ga ? "L" : "D";
        return outcome + `(${gf}-${ga})`;
      })
      .join(" ");

    const parts = [`last ${teamMatches.length} (football-data.co.uk${seasonNote}): ${form}`];

    if (ref.rich) {
      const withStats = teamMatches.filter((m) => m.homeCorners != null || m.homeYellow != null);
      if (withStats.length > 0) {
        const avg = (pick: (m: ParsedMatch) => number | undefined) => {
          const vals = withStats.map(pick).filter((v): v is number => v != null);
          return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
        };
        const cornersFor = avg((m) => (isTarget(m.home) ? m.homeCorners : m.awayCorners));
        const cardsFor = avg((m) => (isTarget(m.home) ? m.homeYellow : m.awayYellow));
        const foulsFor = avg((m) => (isTarget(m.home) ? m.homeFouls : m.awayFouls));
        if (cornersFor != null) parts.push(`${cornersFor} corners/game`);
        if (cardsFor != null) parts.push(`${cardsFor} yellow cards/game`);
        if (foulsFor != null) parts.push(`${foulsFor} fouls/game`);
      }
    } else {
      parts.push("no corners/cards data available for this league on this source (thin coverage — goals/result only)");
    }

    return {
      teamName,
      summary: `${teamName}: ${parts.join(", ")}.`,
      raw: { matchCount: teamMatches.length, rich: ref.rich },
    };
  }

  /**
   * League-wide team goal-scoring/conceding rates, added 2026-08-24 for
   * the Poisson baseline model (src/lib/poissonModel.ts) — separate from
   * fetchTeamStats above, which only ever looks at ONE team's recent
   * form. This aggregates the WHOLE league's match list at once (already
   * fetched via the same getLeagueMatches/cache this class already has)
   * into home/away attack-strength and defense-weakness ratios relative
   * to the league average, per Maher's classic model.
   *
   * MIN_MATCHES_FOR_RATE (5): a team with only 1-2 matches in a venue
   * context produces a wildly noisy ratio driven by one scoreline — seen
   * directly earlier this session with Zulte-Waregem/Genk having ZERO
   * current-season matches at all in early August. Below the threshold,
   * that team's profile is omitted rather than returned as if reliable.
   *
   * Returns null only if the league itself has no matches at all (should
   * be rare — getLeagueMatches already falls back to the previous season
   * if the current one hasn't started). Individual teams below the match
   * threshold are simply absent from the two Maps, not an all-or-nothing
   * failure for the whole league.
   */
  async getLeagueTeamRates(sportKey: string): Promise<LeagueTeamRates | null> {
    const ref = LEAGUE_MAP[sportKey];
    if (!ref) return null;

    const matches = await this.getLeagueMatches(ref);
    if (!matches) return null;
    return aggregateTeamRates(matches);
  }

  /** Same fuzzy name matching as fetchTeamStats (ESPN "Club (City)" vs this source's plain names) — public so callers building on getLeagueTeamRates don't have to reimplement it. */
  findTeamRate(rates: Map<string, TeamGoalProfileWithMeta>, teamName: string): TeamGoalProfileWithMeta | null {
    const targetVariants = normalizeVariants(teamName);
    for (const [rawName, profile] of rates) {
      if (targetVariants.includes(normalize(rawName))) return profile;
    }
    return null;
  }

  private async getLeagueMatches(ref: LeagueRef): Promise<ParsedMatch[] | null> {
    const cacheKey = `${ref.path}:${ref.code}`;
    const cached = fileCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.matches;

    if (ref.path === "new") {
      const matches = await this.fetchOne(`${BASE_URL}/new/${ref.code}.csv`, false);
      fileCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, matches });
      return matches;
    }

    // Rich/season-specific path: try the current season, fall back to the
    // previous one if it doesn't exist yet (see file header — confirmed
    // live that the new season's files don't exist until leagues actually
    // start playing it).
    for (const offset of [0, -1]) {
      const matches = await this.fetchOne(`${BASE_URL}/mmz4281/${seasonCode(offset)}/${ref.code}.csv`, true);
      if (matches) {
        fileCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, matches });
        return matches;
      }
    }
    fileCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, matches: null });
    return null;
  }

  private async fetchOne(url: string, rich: boolean): Promise<ParsedMatch[] | null> {
    try {
      const { data, headers } = await axios.get<string>(url, { timeout: 10_000, responseType: "text" });
      if (!String(headers["content-type"] ?? "").includes("csv")) return null; // e.g. the season-not-started HTML error page
      const matches = parseCsv(data, rich);
      return matches.length > 0 ? matches : null;
    } catch (err) {
      console.error(`[FootballDataCoUkProvider] fetch failed for "${url}":`, (err as Error).message);
      return null;
    }
  }
}
