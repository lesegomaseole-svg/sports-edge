/**
 * Match statistics from SofaScore, via the RapidAPI-hosted wrapper at
 * https://rapidapi.com/apisummit/api/sofascore-sport-api (host:
 * sofascore-sport-api.p.rapidapi.com — NOT the more commonly-referenced
 * "sofascore.p.rapidapi.com"/apidojo listing, which this key isn't
 * subscribed to; confirmed live by trial, not assumed from docs).
 *
 * ENDPOINT DISCOVERY (2026-08-01, this listing has no public docs
 * reachable via automated fetch — everything below was found by live
 * trial against the real key, not read from documentation):
 *   - GET /api/search/all?q={name} -> team id (also players/tournaments/
 *     etc. in the same result set, filtered by entity.sport.slug).
 *   - GET /api/team/{id}/events/last/0 -> up to 30 recent events
 *     (`/previous/0` 404s — "last" is the real keyword), each with
 *     homeTeam.id/awayTeam.id, status.type ("finished" for completed),
 *     and startTimestamp.
 *   - GET /api/event/{id}/statistics -> both teams' full stat sheet for
 *     one match, grouped (Match overview, Shots, Attack, Passes, Duels,
 *     Defending, Goalkeeping), each item as {key, name, home, away,
 *     homeValue, awayValue}.
 *   - GET /api/event/{id}/lineups -> formations + full squad (available,
 *     not used here — this provider only needs post-match statistics,
 *     matching EspnMatchStatsProvider's scope; a future lineups-focused
 *     provider could reuse this same team/event resolution path).
 *
 * DOES THIS DUPLICATE ESPN (this app's "FBref" corners/cards source)?
 * NO — confirmed by direct comparison of one real match's data:
 *   - ESPN's box score has: fouls, yellow/red cards, offsides, corners,
 *     saves, possession%, shots, shots-on-target, shot%, penalties,
 *     passes/passPct, crosses, long balls.
 *   - SofaScore's statistics endpoint has all of that PLUS: expected
 *     goals (xG — genuinely new signal, no other source in this app has
 *     it), big chances created/scored/missed, shots inside/outside box,
 *     blocked shots, hit woodwork, through balls, touches in the box,
 *     tackles/tackle win %, interceptions, clearances, aerial/ground duel
 *     win %, dribble success %, distance covered, sprints, and advanced
 *     goalkeeping (goals prevented, big saves, high claims, punches).
 *   xG alone justifies keeping this as a separate source rather than
 *   treating it as redundant with ESPN.
 *
 * QUOTA — THE BINDING CONSTRAINT, READ BEFORE CHANGING CALL PATTERNS:
 * confirmed live via x-ratelimit-requests-* response headers: this key's
 * plan allows exactly 200 requests, resetting roughly monthly (~31 days
 * per x-ratelimit-requests-reset), NOT daily. (The much larger
 * x-ratelimit-rapid-free-plans-hard-limit-* headers, 500000, are
 * RapidAPI's platform-wide free-tier ceiling across every API — not this
 * one's actual limit; the 200/~31-day pair is what actually binds.) This
 * is far tighter than every other stats source in this app (API-Football:
 * 100/day; SportMonks: 3000/hour). ~27 requests were spent on live
 * discovery/testing while building this file (including a real bug catch
 * — see below — and losing the in-process cache to a few dev-server
 * restarts along the way, itself a useful data point: this cache only
 * protects a long-running production process, not a dev loop that
 * restarts on every save), leaving ~173 for the rest of this key's
 * cycle. Design consequences:
 *   - Team-id resolution (search) is cached IN-PROCESS INDEFINITELY, not
 *     just for a TTL window — a team's id never changes, so this cost is
 *     paid at most once per team per process lifetime.
 *   - The final built summary is ALSO cached, for CACHE_TTL_MS (24h) —
 *     unusually long compared to this app's other providers — specifically
 *     so re-analysing the same team more than once in a day (a second
 *     "Analyse" click, or two fixtures involving the same team) doesn't
 *     cost fresh quota.
 *   - Only the SINGLE most recent finished match is used, not averaged
 *     over N like EspnMatchStatsProvider's last-5 — that would be 1 events
 *     call + 5 statistics calls per team (12 per single fixture analysis,
 *     both teams) against a 200-request MONTHLY budget. One events call +
 *     one statistics call per team (up to 4 total per fixture, fewer with
 *     search-cache hits) is the only sane rate against this quota.
 *   - Given ~173 requests remaining and up to 4 per fixture, this source
 *     is realistically usable for on the order of dozens of "Analyse"
 *     clicks per month, not a routine per-pick data point — expect
 *     DataSourceHealth to show this idle/unattempted most of the time by
 *     design (analyzeEvent.ts still calls it like any other stats
 *     provider; there's no separate throttle beyond the caching above and
 *     the standard 3-strikes auto-disable, which — usefully — will kick
 *     in and quiet this source down automatically if the monthly quota
 *     is ever actually exhausted and starts erroring).
 *
 * BUG FOUND + FIXED 2026-08-01 (once tested against a lower-profile
 * league than the Champions League sample this was first built against):
 * `data.statistics` can be entirely absent for a match (not just an empty
 * array) — a raw `.find()` on it threw. See the null-safe guard in
 * fetchTeamStats() below. Found on a real Eliteserien fixture.
 *
 * Not wired into oddsIngestion.ts's sufficiency scoring, same reasoning
 * as (and even stronger than) ApiFootballStatsProvider/FootballDataStatsProvider
 * — that loop runs per new fixture across every tracked league, which
 * would exhaust this 200/month budget in a single cycle. Prompt-time only.
 */
import axios from "axios";
import { StatsProvider, StatsSnapshot } from "./StatsProvider";

const HOST = "sofascore-sport-api.p.rapidapi.com";
const BASE_URL = `https://${HOST}`;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — see quota note above

interface SearchEntity {
  id: number;
  name: string;
  sport?: { slug: string };
}
interface SearchResult {
  entity: SearchEntity;
  type?: string;
}
interface SearchResponse {
  results: SearchResult[];
}

interface EventTeamRef {
  id: number;
  name: string;
}
interface EventSummary {
  id: number;
  homeTeam: EventTeamRef;
  awayTeam: EventTeamRef;
  status: { type: string };
  startTimestamp: number;
}
interface TeamEventsResponse {
  events: EventSummary[];
}

interface StatItem {
  key: string;
  name: string;
  homeValue?: number;
  awayValue?: number;
}
interface StatGroup {
  groupName: string;
  statisticsItems: StatItem[];
}
interface StatisticsResponse {
  statistics: { period: string; groups: StatGroup[] }[];
}

interface CacheEntry {
  expiresAt: number;
  snapshot: StatsSnapshot | null;
}

// The handful of fields worth surfacing in the prompt — corners/cards
// (parity with ESPN) plus the genuinely new signal (xG, shots, big
// chances, possession) that justifies this as a non-duplicate source.
const SUMMARY_STAT_KEYS = ["cornerKicks", "yellowCards", "fouls", "expectedGoals", "bigChanceCreated", "totalShotsOnGoal", "shotsOnGoal", "ballPossession"] as const;

export class SofaScoreRapidApiProvider implements StatsProvider {
  readonly name = "sofascore";
  private teamIdCache = new Map<string, number | null>();
  private snapshotCache = new Map<string, CacheEntry>();

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error("SofaScoreRapidApiProvider requires SOFASCORE_RAPIDAPI_KEY to be set");
    }
  }

  async fetchTeamStats(teamName: string, _sportKey: string): Promise<StatsSnapshot | null> {
    const cacheKey = teamName.toLowerCase();
    const cached = this.snapshotCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.snapshot;

    try {
      const teamId = await this.resolveTeamId(teamName);
      if (teamId == null) {
        this.snapshotCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, snapshot: null });
        return null;
      }

      const event = await this.mostRecentFinishedEvent(teamId);
      if (!event) {
        this.snapshotCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, snapshot: null });
        return null;
      }

      const isHome = event.homeTeam.id === teamId;
      const { data } = await axios.get<StatisticsResponse>(`${BASE_URL}/api/event/${event.id}/statistics`, {
        headers: { "x-rapidapi-key": this.apiKey, "x-rapidapi-host": HOST },
        timeout: 10_000,
      });

      // BUG FOUND + FIXED 2026-08-01: `data.statistics` itself can be
      // absent (not just empty) for a match — confirmed live on an
      // Eliteserien fixture (a lower-profile league than the Champions
      // League sample this was first built against), which threw
      // "Cannot read properties of undefined (reading 'find')" before
      // this null-safe guard.
      const items = new Map<string, StatItem>();
      for (const group of (data.statistics ?? []).find((s) => s.period === "ALL")?.groups ?? []) {
        for (const item of group.statisticsItems) items.set(item.key, item);
      }

      if (items.size === 0) {
        const snapshot: StatsSnapshot = { teamName, summary: `${teamName}: resolved on SofaScore but its most recent match has no statistics recorded.` };
        this.snapshotCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, snapshot });
        return snapshot;
      }

      const pick = (key: string): number | undefined => {
        const item = items.get(key);
        if (!item) return undefined;
        return isHome ? item.homeValue : item.awayValue;
      };

      const parts: string[] = [];
      const corners = pick("cornerKicks");
      if (corners != null) parts.push(`${corners} corners`);
      const yellow = pick("yellowCards");
      if (yellow != null) parts.push(`${yellow} yellow cards`);
      const fouls = pick("fouls");
      if (fouls != null) parts.push(`${fouls} fouls`);
      const xg = pick("expectedGoals");
      if (xg != null) parts.push(`${xg.toFixed(2)} xG`);
      const bigChances = pick("bigChanceCreated");
      if (bigChances != null) parts.push(`${bigChances} big chances created`);
      const shots = pick("totalShotsOnGoal");
      const shotsOnTarget = pick("shotsOnGoal");
      if (shots != null) parts.push(`${shots} shots${shotsOnTarget != null ? ` (${shotsOnTarget} on target)` : ""}`);
      const possession = pick("ballPossession");
      if (possession != null) parts.push(`${possession}% possession`);

      if (parts.length === 0) {
        const snapshot: StatsSnapshot = { teamName, summary: `${teamName}: resolved on SofaScore but its most recent match had no usable statistics.` };
        this.snapshotCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, snapshot });
        return snapshot;
      }

      const matchDate = new Date(event.startTimestamp * 1000).toISOString().slice(0, 10);
      const snapshot: StatsSnapshot = {
        teamName,
        summary: `${teamName}: [SofaScore, most recent match only (${matchDate}), not a multi-match average] ${parts.join(", ")}.`,
        raw: { eventId: event.id, matchDate, ...Object.fromEntries(SUMMARY_STAT_KEYS.map((k) => [k, pick(k)])) },
      };
      this.snapshotCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, snapshot });
      return snapshot;
    } catch (err) {
      console.error(`[SofaScoreRapidApiProvider] fetchTeamStats failed for "${teamName}":`, (err as Error).message);
      // Quota exhaustion (added 2026-08-04) is re-thrown rather than
      // swallowed to null like every other error here — analyzeEvent.ts's
      // fetchTeamStatsSafely() catches it and tags dataSourceHealth with a
      // distinct "quota_exhausted" reason instead of the generic failure
      // count, so hitting zero on this key's 200-request budget doesn't
      // read as this source being broken (see dataSourceHealth.ts).
      const response = (err as { response?: { status?: number; headers?: Record<string, string> } })?.response;
      const quotaExhausted = response?.status === 429 || response?.headers?.["x-ratelimit-requests-remaining"] === "0";
      if (quotaExhausted) throw err;
      return null;
    }
  }

  private async resolveTeamId(teamName: string): Promise<number | null> {
    const cacheKey = teamName.toLowerCase();
    if (this.teamIdCache.has(cacheKey)) return this.teamIdCache.get(cacheKey)!;

    const { data } = await axios.get<SearchResponse>(`${BASE_URL}/api/search/all`, {
      headers: { "x-rapidapi-key": this.apiKey, "x-rapidapi-host": HOST },
      params: { q: teamName },
      timeout: 10_000,
    });

    const match = data.results.find((r) => r.entity.sport?.slug === "football" && r.entity.name.toLowerCase() === teamName.toLowerCase());
    const id = match?.entity.id ?? null;
    this.teamIdCache.set(cacheKey, id);
    return id;
  }

  private async mostRecentFinishedEvent(teamId: number): Promise<EventSummary | null> {
    const { data } = await axios.get<TeamEventsResponse>(`${BASE_URL}/api/team/${teamId}/events/last/0`, {
      headers: { "x-rapidapi-key": this.apiKey, "x-rapidapi-host": HOST },
      timeout: 10_000,
    });

    const finished = (data.events ?? [])
      .filter((e) => e.status.type === "finished")
      .sort((a, b) => b.startTimestamp - a.startTimestamp);

    return finished[0] ?? null;
  }
}
