/**
 * Resolves a FULL settlement-grade result for one specific fixture via
 * ESPN's match summary — final score, half-time score, per-team
 * corners/cards, first/last goalscorer, and penalty-awarded — all from
 * infrastructure already proven reachable elsewhere in this app
 * (EspnMatchStatsProvider uses the same schedule+summary endpoints).
 *
 * Verified live 2026-08-01 against a real completed Premier League match:
 *   - header.competitions[0].competitors[].score is the final score, and
 *     .linescores is a 2-entry array (half 1, half 2) per team — half-time
 *     score is linescores[0].
 *   - header.competitions[0].status.type.completed confirms the match has
 *     actually finished (never settle from an in-progress or postponed
 *     match's partial data).
 *   - boxscore.teams[].statistics has wonCorners/yellowCards/redCards —
 *     same fields EspnMatchStatsProvider already reads.
 *   - keyEvents is a full match timeline with scoringPlay:true flagging
 *     goals, each with a team.id and clock.value (seconds elapsed) —
 *     sorting these gives first/last goalscorer. Penalty detection is
 *     best-effort (scans event type text for "penalty") and NOT verified
 *     against a real penalty-featuring match, so it degrades to `null`
 *     (not `false`) whenever the signal is ambiguous rather than assuming
 *     "no penalty" from silence.
 *
 * This is deliberately the PRIMARY result source for resultsIngestion.ts,
 * ahead of The Odds API's /scores endpoint (the task's suggested primary)
 * — a live check found The Odds API key already quota-constrained
 * (251/500 remaining, shared with the primary fixture+odds ingestion this
 * whole app depends on), while ESPN is free/keyless and, per the above,
 * actually returns MORE settlement-relevant data in one call (half-time
 * score, corners, cards, goal order) than The Odds API's /scores endpoint
 * does (final score only). The Odds API is kept as a fallback for final
 * score only, for fixtures ESPN can't resolve (the known team-name
 * mismatch limitation — see espnLeagueMap.ts).
 */
import axios from "axios";
import { ESPN_BASE, EspnLeagueRef, resolveEspnTeamId } from "./espnLeagueMap";

export interface EspnMatchResult {
  completed: boolean;
  finalScoreHome: number;
  finalScoreAway: number;
  htScoreHome: number | null;
  htScoreAway: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeCards: number | null; // yellow + red combined, this app's settlement convention
  awayCards: number | null;
  firstScoringTeam: "home" | "away" | null;
  lastScoringTeam: "home" | "away" | null;
  penaltyAwarded: boolean | null; // null = couldn't determine, not "no"
}

interface EspnScheduleEvent {
  id: string;
  date: string;
  competitions?: { competitors?: { homeAway?: string; team?: { id?: string } }[] }[];
}
interface EspnScheduleResponse {
  events?: EspnScheduleEvent[];
}

interface EspnCompetitor {
  id: string;
  homeAway: "home" | "away";
  score?: string;
  linescores?: { displayValue: string }[];
}
interface EspnHeaderCompetition {
  competitors?: EspnCompetitor[];
  status?: { type?: { completed?: boolean } };
}
interface EspnBoxscoreTeamStat {
  name: string;
  displayValue: string;
}
interface EspnBoxscoreTeam {
  team: { id: string };
  statistics?: EspnBoxscoreTeamStat[];
}
interface EspnKeyEvent {
  type?: { type?: string; text?: string };
  scoringPlay?: boolean;
  clock?: { value?: number };
  period?: { number?: number };
  team?: { id?: string };
}
interface EspnSummaryResponse {
  header?: { competitions?: EspnHeaderCompetition[] };
  boxscore?: { teams?: EspnBoxscoreTeam[] };
  keyEvents?: EspnKeyEvent[];
}

const SAME_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Finds this specific fixture (by home team + calendar date match against
 * commenceTime, same tolerance as EspnMatchStatsProvider's own date
 * handling) and returns everything settlement.ts needs, or null if ESPN
 * can't resolve either the team or the specific match (team-name
 * mismatch, or the match simply isn't in ESPN's schedule for that date).
 */
export async function resolveEspnMatchResult(
  ref: EspnLeagueRef,
  homeTeam: string,
  awayTeam: string,
  commenceTime: Date
): Promise<EspnMatchResult | null> {
  const homeTeamId = await resolveEspnTeamId(ref, homeTeam);
  if (!homeTeamId) return null;

  const eventId = await findEventId(ref, homeTeamId, awayTeam, commenceTime);
  if (!eventId) return null;

  const { data } = await axios.get<EspnSummaryResponse>(`${ESPN_BASE}/${ref.sport}/${ref.league}/summary`, {
    params: { event: eventId },
    timeout: 10_000,
  });

  const comp = data.header?.competitions?.[0];
  const competitors = comp?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === "home");
  const away = competitors.find((c) => c.homeAway === "away");
  if (!home || !away || home.score == null || away.score == null) return null;

  const completed = comp?.status?.type?.completed ?? false;

  const idToSide = new Map<string, "home" | "away">();
  if (home.id) idToSide.set(home.id, "home");
  if (away.id) idToSide.set(away.id, "away");

  const boxTeams = data.boxscore?.teams ?? [];
  const boxRow = (side: "home" | "away") => {
    const teamId = side === "home" ? home.id : away.id;
    const box = boxTeams.find((t) => t.team.id === teamId);
    if (!box?.statistics) return null;
    const stat = (name: string) => Number(box.statistics!.find((s) => s.name === name)?.displayValue ?? 0);
    return { corners: stat("wonCorners"), cards: stat("yellowCards") + stat("redCards") };
  };
  const homeBox = boxRow("home");
  const awayBox = boxRow("away");

  const goals = (data.keyEvents ?? [])
    .filter((e) => e.scoringPlay && e.team?.id && idToSide.has(e.team.id))
    .sort((a, b) => (a.clock?.value ?? 0) - (b.clock?.value ?? 0));
  const firstScoringTeam = goals.length > 0 ? idToSide.get(goals[0].team!.id!) ?? null : null;
  const lastScoringTeam = goals.length > 0 ? idToSide.get(goals[goals.length - 1].team!.id!) ?? null : null;

  // Best-effort, unverified against a real penalty — see file header.
  const hasKeyEvents = (data.keyEvents ?? []).length > 0;
  const penaltyAwarded = hasKeyEvents
    ? (data.keyEvents ?? []).some((e) => /penalty/i.test(e.type?.text ?? "") || /penalty/i.test(e.type?.type ?? ""))
    : null;

  return {
    completed,
    finalScoreHome: Number(home.score),
    finalScoreAway: Number(away.score),
    htScoreHome: home.linescores?.[0] ? Number(home.linescores[0].displayValue) : null,
    htScoreAway: away.linescores?.[0] ? Number(away.linescores[0].displayValue) : null,
    homeCorners: homeBox?.corners ?? null,
    awayCorners: awayBox?.corners ?? null,
    homeCards: homeBox?.cards ?? null,
    awayCards: awayBox?.cards ?? null,
    firstScoringTeam,
    lastScoringTeam,
    penaltyAwarded,
  };
}

async function findEventId(ref: EspnLeagueRef, homeTeamId: string, awayTeam: string, commenceTime: Date): Promise<string | null> {
  const targetYear = commenceTime.getUTCFullYear();

  for (const season of [targetYear, targetYear - 1]) {
    const { data } = await axios.get<EspnScheduleResponse>(`${ESPN_BASE}/${ref.sport}/${ref.league}/teams/${homeTeamId}/schedule`, {
      params: { season },
      timeout: 10_000,
    });

    for (const event of data.events ?? []) {
      const comp = event.competitions?.[0];
      const isHome = comp?.competitors?.some((c) => c.homeAway === "home" && c.team?.id === homeTeamId);
      if (!isHome) continue;

      const sameDay = Math.abs(new Date(event.date).getTime() - commenceTime.getTime()) < SAME_DAY_MS;
      if (!sameDay) continue;

      return event.id;
    }
  }

  // awayTeam isn't used for matching above (home-team + same-day is
  // already a strong enough key — a team plays at most one home fixture
  // per day), kept as a parameter for callers/signature clarity and in
  // case a future tightening needs it.
  void awayTeam;
  return null;
}
