/**
 * Shared sportKey -> ESPN {sport, league} mapping, used by both
 * EspnFixtureProvider and EspnStatsProvider so the two stay in sync (a
 * team's fixtures and its stats have to come from the same ESPN league to
 * make sense together).
 *
 * These hit site.api.espn.com/apis/site/v2/sports/{sport}/{league}/... —
 * the undocumented endpoints espn.com's own frontend calls internally, not
 * an official public API. No key required, but no stability guarantee
 * either.
 *
 * The app is soccer-only as of this writing (see MARKET_MENUS in
 * src/lib/analyzeEvent.ts) — all 10 entries below were verified live on
 * 2026-07-31: each returns HTTP 200 with the correct league name and
 * real non-empty fixture data from /scoreboard, and a real non-empty team
 * list from /teams (needed for EspnStatsProvider / EspnMatchStatsProvider
 * to resolve a team name to an id). Slugs found via the standard ESPN
 * soccer convention ({country-code}.{division}) plus the two UEFA
 * competitions' known slugs; every one was confirmed live rather than
 * assumed to work from the pattern alone.
 */

import axios from "axios";

export interface EspnLeagueRef {
  sport: string;
  league: string;
}

export const ESPN_LEAGUE_BY_SPORT_KEY: Record<string, EspnLeagueRef> = {
  soccer_epl: { sport: "soccer", league: "eng.1" },
  soccer_spain_la_liga: { sport: "soccer", league: "esp.1" },
  soccer_italy_serie_a: { sport: "soccer", league: "ita.1" },
  soccer_germany_bundesliga: { sport: "soccer", league: "ger.1" },
  soccer_france_ligue_one: { sport: "soccer", league: "fra.1" },
  soccer_uefa_champs_league: { sport: "soccer", league: "uefa.champions" },
  soccer_uefa_europa_league: { sport: "soccer", league: "uefa.europa" },
  soccer_portugal_primeira_liga: { sport: "soccer", league: "por.1" },
  soccer_netherlands_eredivisie: { sport: "soccer", league: "ned.1" },
  soccer_usa_mls: { sport: "soccer", league: "usa.1" },
  // 10 more added + verified live 2026-08-01 (teams endpoint 200 + real
  // non-empty team list for each; schedule/boxscore spot-checked on a
  // couple of these, same season-fallback pattern as the original 10).
  soccer_efl_champ: { sport: "soccer", league: "eng.2" },
  soccer_spl: { sport: "soccer", league: "sco.1" },
  soccer_denmark_superliga: { sport: "soccer", league: "den.1" },
  soccer_brazil_campeonato: { sport: "soccer", league: "bra.1" },
  soccer_argentina_primera_division: { sport: "soccer", league: "arg.1" },
  soccer_saudi_arabia_pro_league: { sport: "soccer", league: "ksa.1" },
  soccer_turkey_super_league: { sport: "soccer", league: "tur.1" },
  soccer_belgium_first_div: { sport: "soccer", league: "bel.1" },
  soccer_mexico_ligamx: { sport: "soccer", league: "mex.1" },
  soccer_japan_j_league: { sport: "soccer", league: "jpn.1" },
  // Verified live 2026-08-01 (teams endpoint 200, 16 real teams).
  soccer_norway_eliteserien: { sport: "soccer", league: "nor.1" },
};

export const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";

interface EspnTeamListResponse {
  sports?: { leagues?: { teams?: { team: { id: string; displayName: string } }[] }[] }[];
}

// Explicit aliases (added 2026-08-04) for the naming mismatches documented
// in docs/corners-cards-audit.md — cases where our stored team name has no
// mechanical relationship to ESPN's real displayName (an abbreviation or a
// nickname, not a punctuation/accent/suffix variant), so normalizeForMatch
// below can't bridge them on its own. Root cause: these picks were all
// generated before the 2026-08-03 fixture/odds decoupling, when Event
// homeTeam/awayTeam came from The Odds API's naming convention, not ESPN's
// — ESPN's own scoreboard and /teams endpoints were confirmed live to
// already agree with each other, so this isn't an ESPN-internal
// inconsistency. Keyed by ESPN league code since the same shorthand could
// plausibly mean different things in different leagues.
// - "Los Angeles FC" -> "LAFC": abbreviation, no shared substring.
// - "Hearts" -> "Heart of Midlothian": common nickname, no shared substring.
// Not included here (resolve via normalizeForMatch or the fuzzy fallback
// below instead, verified against the live team lists in the worksheet):
// Falkirk F.C., Belgrano de Cordoba, Gimnasia Mendoza, Union Santa Fe,
// Fredrikstad FK, Vancouver Whitecaps FC, Columbus Crew SC, Newells Old
// Boys (suffix/accent/apostrophe/parenthetical normalization), Tigres
// (fuzzy prefix match against "Tigres UANL"). "Estudiantes" is deliberately
// NOT resolved anywhere in this chain — arg.1 has two similarly-named
// clubs (Estudiantes de La Plata, Estudiantes de Río Cuarto) and there's no
// reliable way to tell which one a bare "Estudiantes" meant; see the
// ambiguous-match branch below.
const ESPN_TEAM_ALIASES: Record<string, Record<string, string>> = {
  "usa.1": { "los angeles fc": "LAFC" },
  "sco.1": { hearts: "Heart of Midlothian" },
};

// For fuzzy comparison only — never used for display/storage. Strips
// diacritics, punctuation, and common administrative club-suffix tokens
// (deliberately NOT stripping identity-bearing words like "United" or
// "City", which would risk merging genuinely different clubs) so e.g.
// "Vancouver Whitecaps FC" and ESPN's "Vancouver Whitecaps" normalize to
// the same string. See docs/corners-cards-audit.md for the specific cases
// this was built to catch.
function normalizeForMatch(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (Córdoba -> Cordoba)
    .toLowerCase()
    .replace(/\(([^)]+)\)/g, " $1 ") // unwrap parens: "Belgrano (Cordoba)" -> "Belgrano Cordoba"
    .replace(/[.']/g, "") // strip periods/apostrophes: "F.C." -> "FC", "Newell's" -> "Newells"
    .replace(/\bde\b/g, " ") // "Belgrano de Cordoba" -> "Belgrano Cordoba"
    .replace(/\b(fc|sc|cf|afc|fk)\b/g, " ") // common administrative suffixes
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Resolves a team display name (e.g. "Arsenal") to its ESPN numeric team
 * id within a given league — shared by EspnStatsProvider and
 * EspnMatchStatsProvider, both of which need it as the first step before
 * fetching team-specific data.
 *
 * Resolution order, each step logged when it's the one that actually
 * matched (added 2026-08-04 — see docs/corners-cards-audit.md, which found
 * 10 of 25 audited picks lost corners/cards data to exactly this kind of
 * mismatch, not genuine data absence):
 *   1. Exact, case-insensitive match (the original, fast-path behavior —
 *      still what most ESPN-sourced fixtures hit, since ESPN's own
 *      scoreboard and /teams endpoints already agree with each other).
 *   2. ESPN_TEAM_ALIASES — curated, unambiguous overrides for names with
 *      no mechanical relationship to ESPN's real name.
 *   3. normalizeForMatch equality — catches accent/punctuation/suffix
 *      variants generically.
 *   4. Fuzzy prefix match on the normalized form, ONLY if exactly one team
 *      qualifies — catches partial names like "Tigres" -> "Tigres UANL".
 * If step 3 or 4 matches MORE than one team, or nothing matches at all,
 * this logs the ambiguity/failure visibly and returns null rather than
 * guessing — a wrong silent guess would be worse than a loud gap, same
 * direction as this app's other safe-fail points (see dataSourceHealth.ts).
 */
export async function resolveEspnTeamId(ref: EspnLeagueRef, teamName: string): Promise<string | null> {
  const { data } = await axios.get<EspnTeamListResponse>(`${ESPN_BASE}/${ref.sport}/${ref.league}/teams`, {
    timeout: 10_000,
  });

  const teams = data.sports?.[0]?.leagues?.[0]?.teams ?? [];

  const exact = teams.find((t) => t.team.displayName.toLowerCase() === teamName.toLowerCase());
  if (exact) return exact.team.id;

  const aliasTarget = ESPN_TEAM_ALIASES[ref.league]?.[teamName.toLowerCase()];
  if (aliasTarget) {
    const aliased = teams.find((t) => t.team.displayName.toLowerCase() === aliasTarget.toLowerCase());
    if (aliased) {
      console.warn(`[espnLeagueMap] resolved "${teamName}" via alias -> "${aliased.team.displayName}" (${ref.league}/${ref.sport})`);
      return aliased.team.id;
    }
  }

  const normalizedQuery = normalizeForMatch(teamName);
  const normalizedMatches = teams.filter((t) => normalizeForMatch(t.team.displayName) === normalizedQuery);
  if (normalizedMatches.length === 1) {
    console.warn(`[espnLeagueMap] resolved "${teamName}" via normalization -> "${normalizedMatches[0].team.displayName}" (${ref.league}/${ref.sport})`);
    return normalizedMatches[0].team.id;
  }
  if (normalizedMatches.length > 1) {
    console.warn(
      `[espnLeagueMap] AMBIGUOUS: "${teamName}" normalizes to match ${normalizedMatches.length} teams in ${ref.league}: ${normalizedMatches.map((t) => t.team.displayName).join(", ")} — refusing to guess, returning null`
    );
    return null;
  }

  const fuzzyMatches = teams.filter((t) => {
    const n = normalizeForMatch(t.team.displayName);
    return n.startsWith(normalizedQuery) || normalizedQuery.startsWith(n);
  });
  if (fuzzyMatches.length === 1) {
    console.warn(`[espnLeagueMap] FUZZY-resolved "${teamName}" -> "${fuzzyMatches[0].team.displayName}" (${ref.league}/${ref.sport}) — spot-check if this looks wrong`);
    return fuzzyMatches[0].team.id;
  }
  if (fuzzyMatches.length > 1) {
    console.warn(
      `[espnLeagueMap] AMBIGUOUS (fuzzy): "${teamName}" could be ${fuzzyMatches.length} teams in ${ref.league}: ${fuzzyMatches.map((t) => t.team.displayName).join(", ")} — refusing to guess, returning null`
    );
    return null;
  }

  console.warn(`[espnLeagueMap] NO MATCH for "${teamName}" in ${ref.league}/${ref.sport} — checked exact, alias, normalized, and fuzzy prefix; returning null`);
  return null;
}

interface EspnScheduleVenueEvent {
  date: string;
  competitions?: {
    venue?: { address?: { city?: string } };
    competitors?: { homeAway?: string; team?: { id?: string } }[];
  }[];
}
interface EspnScheduleVenueResponse {
  events?: EspnScheduleVenueEvent[];
}

/**
 * Resolves a team's home-venue city, for WeatherProvider (see
 * src/providers/weather/) — this app's Event model has no venue field, so
 * kickoff weather needs a city derived from the home team. ESPN's
 * per-team schedule already embeds `competitions[].venue.address.city`
 * on every event (verified live 2026-07-31), so this reuses the same
 * schedule endpoint EspnMatchStatsProvider calls rather than adding a new
 * ESPN surface — one extra call, no new infrastructure.
 *
 * Only events where this team is the HOME competitor are considered
 * (an away-fixture's venue belongs to the opponent, not this team), and
 * a stadium doesn't change match to match, so the most recent one found
 * (current-year schedule, falling back to last year during close season,
 * same as EspnMatchStatsProvider) is a reliable proxy for future
 * fixtures too.
 */
export async function resolveHomeVenueCity(ref: EspnLeagueRef, teamName: string): Promise<string | null> {
  const teamId = await resolveEspnTeamId(ref, teamName);
  if (!teamId) return null;

  const currentYear = new Date().getUTCFullYear();
  for (const season of [currentYear, currentYear - 1]) {
    const { data } = await axios.get<EspnScheduleVenueResponse>(`${ESPN_BASE}/${ref.sport}/${ref.league}/teams/${teamId}/schedule`, {
      params: { season },
      timeout: 10_000,
    });

    const sorted = [...(data.events ?? [])].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    for (const event of sorted) {
      const comp = event.competitions?.[0];
      const isHome = comp?.competitors?.some((c) => c.homeAway === "home" && c.team?.id === teamId);
      const city = comp?.venue?.address?.city;
      if (isHome && city) return city;
    }
  }

  return null;
}
