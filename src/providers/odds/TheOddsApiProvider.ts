/**
 * Real odds+fixtures provider backed by https://the-odds-api.com — as of
 * this pivot, this is the app's primary source for BOTH: one call returns
 * events and their h2h odds together (verified live against the v4 docs
 * at https://the-odds-api.com/liveapi/guides/v4/ and against real data,
 * 2026-07-31). Fixtures are no longer pulled from a separate source —
 * see src/lib/oddsIngestion.ts.
 *
 * Server-side date filtering: `commenceTimeFrom`/`commenceTimeTo` (ISO
 * 8601) are real, documented, and verified live — a 3-day-window request
 * against MLS returned exactly the 15 events inside that window, vs. 31
 * for the unfiltered call. This is used instead of fetching broadly and
 * filtering after the fact.
 *
 * `regions` controls which bookmakers' odds come back (ODDS_REGIONS env
 * var, e.g. "uk"). `markets` defaults to h2h-only per this app's current
 * scope (see MARKET_MENU in analyzeEvent.ts — no spreads/handicaps).
 *
 * Swap-in note: nothing outside this file knows about The Odds API's JSON
 * shape. If you later move to a different vendor, implement OddsProvider
 * again and flip ODDS_PROVIDER in .env.
 */
import axios from "axios";
import { NormalizedEvent, OddsMarket, OddsOutcome, OddsProvider, ScoreResult } from "./OddsProvider";

const BASE_URL = "https://api.the-odds-api.com/v4";

interface RawOutcome {
  name: string;
  price: number;
  point?: number;
}
interface RawMarket {
  key: string;
  outcomes: RawOutcome[];
}
interface RawBookmaker {
  key: string;
  title: string;
  markets: RawMarket[];
}
interface RawEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: RawBookmaker[];
}
interface RawSport {
  key: string;
  active: boolean;
}
interface RawScore {
  id: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: { name: string; score: string }[] | null;
}

// The API requires exactly YYYY-MM-DDTHH:MM:SSZ — verified live that
// Date#toISOString()'s milliseconds (".123Z") make it reject the request
// with a 422 INVALID_COMMENCE_TIME_FROM/TO, even though that's still
// valid ISO 8601. Strip them.
function toApiTimestamp(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export class TheOddsApiProvider implements OddsProvider {
  readonly name = "the-odds-api";

  constructor(
    private readonly apiKey: string,
    private readonly regions: string = "uk"
  ) {
    if (!apiKey) {
      throw new Error("TheOddsApiProvider requires THE_ODDS_API_KEY to be set");
    }
  }

  async fetchOdds(sportKey: string, marketTypes: string[] = ["h2h"], window?: { from: Date; to: Date }): Promise<NormalizedEvent[]> {
    try {
      const { data } = await axios.get<RawEvent[]>(`${BASE_URL}/sports/${sportKey}/odds`, {
        params: {
          apiKey: this.apiKey,
          regions: this.regions,
          markets: marketTypes.join(","),
          oddsFormat: "decimal",
          ...(window
            ? {
                commenceTimeFrom: toApiTimestamp(window.from),
                commenceTimeTo: toApiTimestamp(window.to),
              }
            : {}),
        },
        timeout: 10_000,
      });

      return data.map((ev) => this.normalize(ev));
    } catch (err) {
      console.error(`[TheOddsApiProvider] fetchOdds failed for ${sportKey}:`, (err as Error).message);
      return [];
    }
  }

  async listAvailableSportKeys(): Promise<string[]> {
    try {
      const { data } = await axios.get<RawSport[]>(`${BASE_URL}/sports`, {
        params: { apiKey: this.apiKey },
        timeout: 10_000,
      });
      return data.filter((s) => s.active).map((s) => s.key);
    } catch (err) {
      console.error("[TheOddsApiProvider] listAvailableSportKeys failed:", (err as Error).message);
      return [];
    }
  }

  // FALLBACK result source only — see resultsIngestion.ts and
  // espnMatchResult.ts's file header for why ESPN is primary. Verified
  // live 2026-08-01 against the real v4 docs and a real key: GET
  // /v4/sports/{sport}/scores/?daysFrom=1-3&dateFormat=iso, final score
  // only (no half-time, no corners/cards), costs 2 request credits per
  // call (vs 1 without daysFrom) — confirmed via this app's own key,
  // which is shared with (and secondary to) the primary fixture+odds
  // ingestion, hence daysFrom capped at 3 (the API's own max) and this
  // only being called for sportKeys that actually have unsettled picks,
  // never all tracked leagues on principle.
  async fetchScores(sportKey: string, daysFrom: number): Promise<ScoreResult[]> {
    try {
      const { data } = await axios.get<RawScore[]>(`${BASE_URL}/sports/${sportKey}/scores/`, {
        params: { apiKey: this.apiKey, daysFrom: Math.min(Math.max(daysFrom, 1), 3), dateFormat: "iso" },
        timeout: 10_000,
      });

      return data.map((ev) => {
        const home = ev.scores?.find((s) => s.name === ev.home_team);
        const away = ev.scores?.find((s) => s.name === ev.away_team);
        return {
          externalId: ev.id,
          completed: ev.completed,
          homeScore: home ? Number(home.score) : null,
          awayScore: away ? Number(away.score) : null,
        };
      });
    } catch (err) {
      console.error(`[TheOddsApiProvider] fetchScores failed for ${sportKey}:`, (err as Error).message);
      return [];
    }
  }

  private normalize(ev: RawEvent): NormalizedEvent {
    const markets: OddsMarket[] = [];
    for (const bm of ev.bookmakers ?? []) {
      for (const m of bm.markets ?? []) {
        const outcomes: OddsOutcome[] = m.outcomes.map((o) => ({
          name: o.name,
          price: o.price,
          point: o.point,
        }));
        markets.push({ marketType: m.key, bookmaker: bm.title, outcomes });
      }
    }

    return {
      externalId: ev.id,
      sportKey: ev.sport_key,
      homeTeam: ev.home_team,
      awayTeam: ev.away_team,
      commenceTime: ev.commence_time,
      markets,
    };
  }
}
