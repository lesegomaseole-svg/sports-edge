/**
 * Corners + cards ("bookings") data — NOT fbref.com. fbref.com is behind
 * a Cloudflare JS challenge (verified live 2026-07-31: its homepage,
 * robots.txt, and a real team page all return the "Just a moment..."
 * interstitial, not real content). A plain axios/cheerio scraper — what
 * was originally asked for — has no way to solve a JS challenge, so it
 * would fail identically there; this isn't a header/UA problem to tune
 * around, same category of finding as the SofaScore investigation
 * earlier in this project.
 *
 * Instead, this pulls the same underlying signal (corners won, yellow/red
 * cards) from ESPN's own match-summary box score
 * (site.api.espn.com/.../summary?event={id}) — infrastructure already
 * proven reachable elsewhere in this app — averaged over each team's last
 * few completed matches to build a "recent form" figure. Verified live
 * 2026-07-31 against a real completed Premier League match: the boxscore
 * includes exactly `wonCorners`, `yellowCards`, `redCards`,
 * `foulsCommitted` per team.
 *
 * Two extra wrinkles found during verification:
 *   - The team schedule endpoint (.../teams/{id}/schedule) needs an
 *     explicit `season` query param — it defaults to the *current* ESPN
 *     season, which during the close season has zero events yet. This
 *     tries the current calendar year first, falling back to the
 *     previous year if that comes back empty.
 *   - This provider makes several sequential ESPN calls per team (1
 *     schedule + up to RECENT_MATCH_COUNT summaries) — meaningfully more
 *     than the other providers' 1-2 calls. A small delay between summary
 *     fetches is added as a courtesy, since ESPN's endpoints are
 *     undocumented and this is the highest-volume consumer of them.
 */
import axios from "axios";
import { StatsProvider, StatsSnapshot } from "./StatsProvider";
import { ESPN_LEAGUE_BY_SPORT_KEY, ESPN_BASE, EspnLeagueRef, resolveEspnTeamId } from "../espn/espnLeagueMap";

const RECENT_MATCH_COUNT = 5;
const BETWEEN_REQUESTS_MS = 300;
// Added 2026-08-03: a 1-match "split" isn't a split, it's a single
// outlier observation with the confidence-inspiring shape of a
// statistic — confirmed live the same day (n=1 read "17 corners" for one
// side, an extreme figure the model appears to have correctly discounted
// on its own, per that session's review). Below this, the blended figure
// is shown instead with an explicit suppression note, rather than a
// technically-true-but-misleading n=1/n=2 split.
const MIN_SPLIT_SAMPLE = 3;

interface EspnScheduleEvent {
  id: string;
  date: string;
  competitions?: {
    status?: { type?: { completed?: boolean } };
    // Added 2026-08-02 for home/away splitting (see fetchTeamStats) — same
    // competitors[].homeAway/team.id shape espnMatchResult.ts already
    // relies on elsewhere in this app, reused here rather than a new
    // pattern.
    competitors?: { homeAway?: string; team?: { id?: string } }[];
  }[];
}
interface EspnScheduleResponse {
  events?: EspnScheduleEvent[];
}

interface EspnBoxscoreTeamStat {
  name: string;
  displayValue: string;
}
interface EspnBoxscoreTeam {
  team: { id: string };
  statistics?: EspnBoxscoreTeamStat[];
}
interface EspnSummaryResponse {
  boxscore?: { teams?: EspnBoxscoreTeam[] };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class EspnMatchStatsProvider implements StatsProvider {
  readonly name = "espn-match-stats";

  async fetchTeamStats(teamName: string, sportKey: string): Promise<StatsSnapshot | null> {
    const ref = ESPN_LEAGUE_BY_SPORT_KEY[sportKey];
    if (!ref) {
      console.warn(`[EspnMatchStatsProvider] no ESPN endpoint mapped for sportKey "${sportKey}" — skipping.`);
      return null;
    }

    try {
      const teamId = await resolveEspnTeamId(ref, teamName);
      if (!teamId) {
        console.warn(`[EspnMatchStatsProvider] couldn't resolve team "${teamName}" (${sportKey}) to an ESPN team id.`);
        return null;
      }

      const recentEvents = await this.recentCompletedEventIds(ref, teamId);
      if (recentEvents.length === 0) {
        return {
          teamName,
          summary: `${teamName}: no recent completed matches available for corners/cards data.`,
        };
      }

      const rows: { corners: number; yellow: number; red: number; fouls: number; wasHome: boolean }[] = [];
      for (const { eventId, wasHome } of recentEvents) {
        const row = await this.fetchTeamBoxscoreRow(ref, eventId, teamId);
        if (row) rows.push({ ...row, wasHome });
        await sleep(BETWEEN_REQUESTS_MS);
      }

      if (rows.length === 0) {
        return {
          teamName,
          summary: `${teamName}: recent matches found, but no box score corners/cards data available for them.`,
        };
      }

      const avg = (set: typeof rows, key: keyof (typeof rows)[number]) =>
        +(set.reduce((sum, r) => sum + (r[key] as number), 0) / set.length).toFixed(1);
      const blended = `avg ${avg(rows, "corners")} corners, ${avg(rows, "yellow")} yellow / ${avg(rows, "red")} red cards, ${avg(rows, "fouls")} fouls per game (last ${rows.length} matches, home+away blended)`;

      // Home/away split (added 2026-08-02, n<3 suppression added
      // 2026-08-03): confirmed live 2026-08-01 the split itself matters —
      // a season/recent-form-wide blended average can mask a real
      // home-specific rate, the gap flagged on that day's highest-
      // confidence loss. But a 1-match "split" is one outlier observation
      // wearing a statistic's clothing, not a real average — confirmed
      // live the same week (an n=1 home split read "17 corners" for one
      // side, a figure the model's own reasoning appears to have
      // discounted rather than acted on). Below MIN_SPLIT_SAMPLE, the
      // blended figure is shown with an explicit suppression note instead
      // of a misleadingly-precise-looking n=1/n=2 number; at or above it,
      // the split is shown as before, n still labelled so the model can
      // judge weight for itself.
      const homeRows = rows.filter((r) => r.wasHome);
      const awayRows = rows.filter((r) => !r.wasHome);
      const splitParts: string[] = [];
      for (const [label, set] of [
        ["home", homeRows],
        ["away", awayRows],
      ] as const) {
        if (set.length === 0) continue;
        if (set.length < MIN_SPLIT_SAMPLE) {
          splitParts.push(`${label} split suppressed (insufficient sample: n=${set.length})`);
        } else {
          splitParts.push(`${label} (n=${set.length}): ${avg(set, "corners")} corners, ${avg(set, "yellow")}y/${avg(set, "red")}r cards`);
        }
      }
      const splitSuffix = splitParts.length > 0 ? ` [split: ${splitParts.join("; ")}]` : "";

      return {
        teamName,
        summary: `${teamName}: ${blended}${splitSuffix}.`,
        raw: { matchesUsed: rows.length, rows },
      };
    } catch (err) {
      console.error(`[EspnMatchStatsProvider] fetchTeamStats failed for "${teamName}" (${sportKey}):`, (err as Error).message);
      return null;
    }
  }

  private async recentCompletedEventIds(ref: EspnLeagueRef, teamId: string): Promise<{ eventId: string; wasHome: boolean }[]> {
    const currentYear = new Date().getUTCFullYear();

    for (const season of [currentYear, currentYear - 1]) {
      const { data } = await axios.get<EspnScheduleResponse>(`${ESPN_BASE}/${ref.sport}/${ref.league}/teams/${teamId}/schedule`, {
        params: { season },
        timeout: 10_000,
      });

      const completed = (data.events ?? [])
        .filter((e) => e.competitions?.[0]?.status?.type?.completed)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, RECENT_MATCH_COUNT)
        .map((e) => ({
          eventId: e.id,
          wasHome: e.competitions?.[0]?.competitors?.some((c) => c.homeAway === "home" && c.team?.id === teamId) ?? false,
        }));

      if (completed.length > 0) return completed;
    }

    return [];
  }

  private async fetchTeamBoxscoreRow(
    ref: EspnLeagueRef,
    eventId: string,
    teamId: string
  ): Promise<{ corners: number; yellow: number; red: number; fouls: number } | null> {
    const { data } = await axios.get<EspnSummaryResponse>(`${ESPN_BASE}/${ref.sport}/${ref.league}/summary`, {
      params: { event: eventId },
      timeout: 10_000,
    });

    const teamBox = data.boxscore?.teams?.find((t) => t.team.id === teamId);
    if (!teamBox?.statistics) return null;

    const stat = (name: string) => Number(teamBox.statistics!.find((s) => s.name === name)?.displayValue ?? 0);

    return {
      corners: stat("wonCorners"),
      yellow: stat("yellowCards"),
      red: stat("redCards"),
      fouls: stat("foulsCommitted"),
    };
  }
}
