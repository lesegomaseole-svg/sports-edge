/**
 * Fixture discovery from ESPN's public scoreboard endpoint — no key
 * required, same infrastructure (ESPN_LEAGUE_BY_SPORT_KEY, ESPN_BASE)
 * already proven reachable elsewhere in this app (results ingestion,
 * corners/cards stats, referee lookups — see espnLeagueMap.ts,
 * espnMatchResult.ts, EspnMatchStatsProvider.ts). Verified live 2026-08-03
 * against a real scoreboard response: competitors[] carries an explicit
 * `homeAway: "home"/"away"` field (same one espnMatchResult.ts already
 * relies on for its own schedule lookups), so home/away is read from that
 * field directly rather than assumed from array order.
 *
 * Bounded to TODAY ONLY, matching this app's existing ingestion window
 * (see oddsIngestion.ts) — ESPN's `dates=YYYYMMDD` param takes a single
 * UTC calendar day. Only STATUS_SCHEDULED events with a commence time
 * still in the future are returned; anything already in progress or
 * finished today isn't a fixture this app can still usefully analyze
 * pre-match.
 *
 * A genuine fetch/parse failure THROWS rather than swallowing to []
 * (changed 2026-08-04) — the earlier version caught everything internally
 * and returned an empty array for both "ESPN genuinely has nothing
 * scheduled" and "the request itself failed," which made those two cases
 * indistinguishable to fixtureIngestion.ts and caused it to record a real
 * empty-calendar day as a source failure toward the 3-strike auto-disable
 * (see fixtureIngestion.ts's per-sport try/catch, which now owns this
 * distinction instead).
 */
import axios from "axios";
import { FixtureProvider, NormalizedFixture } from "./FixtureProvider";
import { ESPN_LEAGUE_BY_SPORT_KEY, ESPN_BASE } from "../espn/espnLeagueMap";

interface EspnScoreboardCompetitor {
  homeAway?: string;
  team?: { displayName?: string };
}
interface EspnScoreboardCompetition {
  status?: { type?: { name?: string } };
  competitors?: EspnScoreboardCompetitor[];
}
interface EspnScoreboardEvent {
  id: string;
  date: string;
  competitions?: EspnScoreboardCompetition[];
}
interface EspnScoreboardResponse {
  events?: EspnScoreboardEvent[];
}

function todayUtcDateParam(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

export class EspnFixtureProvider implements FixtureProvider {
  readonly name = "espn-fixtures";

  async fetchFixturesForSport(sportKey: string): Promise<NormalizedFixture[]> {
    const ref = ESPN_LEAGUE_BY_SPORT_KEY[sportKey];
    if (!ref) return [];

    const { data } = await axios.get<EspnScoreboardResponse>(`${ESPN_BASE}/${ref.sport}/${ref.league}/scoreboard`, {
      params: { dates: todayUtcDateParam() },
      timeout: 10_000,
    });

    const now = Date.now();
    const fixtures: NormalizedFixture[] = [];

    for (const event of data.events ?? []) {
      const comp = event.competitions?.[0];
      if (comp?.status?.type?.name !== "STATUS_SCHEDULED") continue;

      const commenceMs = new Date(event.date).getTime();
      if (!Number.isFinite(commenceMs) || commenceMs <= now) continue;

      const homeTeam = comp.competitors?.find((c) => c.homeAway === "home")?.team?.displayName;
      const awayTeam = comp.competitors?.find((c) => c.homeAway === "away")?.team?.displayName;
      if (!homeTeam || !awayTeam) continue;

      fixtures.push({
        externalId: `espn-${event.id}`,
        homeTeam,
        awayTeam,
        commenceTime: new Date(event.date).toISOString(),
      });
    }

    return fixtures;
  }
}
