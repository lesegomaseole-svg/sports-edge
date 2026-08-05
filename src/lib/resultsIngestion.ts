/**
 * Fetches match results for recently-completed fixtures and settles any
 * Picks attached to them. ESPN is the PRIMARY source (free, and — verified
 * live — richer than The Odds API's /scores: half-time score, per-team
 * corners/cards, goal order, not just final score); The Odds API's
 * /scores is the FALLBACK, used only for fixtures ESPN can't resolve (the
 * known team-name-mismatch limitation — see espnLeagueMap.ts), and even
 * then only supplies the final score. See espnMatchResult.ts's file
 * header for the full reasoning on why this inverts the priority named in
 * the original task spec.
 *
 * Health-tracked as two sources ("results-espn", "results-odds-scores"),
 * separate from "espn-match-stats"/"the-odds-api" (the ingestion-time
 * sources) since this is a genuinely different capability (fetching a
 * COMPLETED match's result vs. an upcoming fixture's odds/recent-form
 * stats) that can fail independently — reported once per cycle, same
 * "aggregate across the whole cycle, not per-event" pattern as
 * oddsIngestion.ts uses, so one stubborn fixture doesn't read as the
 * whole source being broken.
 */
import { prisma } from "../db/client";
import { getOddsProvider } from "../providers/odds";
import { ESPN_LEAGUE_BY_SPORT_KEY } from "../providers/espn/espnLeagueMap";
import { resolveEspnMatchResult, EspnMatchResult } from "../providers/espn/espnMatchResult";
import { settlePick, MatchResultForSettlement } from "./settlement";
import { shouldAttempt, recordAttempt } from "./dataSourceHealth";

const ESPN_RESULTS_SOURCE_ID = "results-espn";
const ODDS_RESULTS_SOURCE_ID = "results-odds-scores";
const DEFAULT_DAYS_BACK = 3; // matches The Odds API's own daysFrom max — no point looking further back for the daily job

// A fixture that kicked off recently genuinely has no result yet — neither
// ESPN nor The Odds API can return one, and resolveEspnMatchResult can't
// tell "team not found" apart from "hasn't started" (both come back null).
// Without this buffer, a cycle that only sees such fixtures records that as
// a SOURCE FAILURE for every one of them, and 3 consecutive cycles like
// that (e.g. from dev-server restarts each firing an immediate tick() —
// see resultsScheduler.ts — shortly after several fixtures kicked off)
// false-disables both results-espn and results-odds-scores even though
// neither is actually broken. This is the same false-disable class fixed
// earlier for espn-match-stats/football-data.org (see oddsIngestion.ts's
// statsAttempted comment) — confirmed live 2026-08-02 against Estudiantes
// de Río Cuarto vs Banfield (finished 0-0, ESPN had it instantly via a
// direct scoreboard call) being unfetchable because both sources had
// already been auto-disabled by exactly this. 3h comfortably covers a
// 90-minute match plus stoppage/delay and ESPN's own reporting lag; it's
// tiny next to the 24h poll interval so it never meaningfully delays a
// real result.
const RESULT_EXPECTED_BUFFER_MS = 3 * 60 * 60 * 1000;

interface EventWithSport {
  id: number;
  externalId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: Date;
  sport: { key: string };
}

export async function runResultsIngestionCycle(daysBack: number = DEFAULT_DAYS_BACK): Promise<{ resultsFetched: number; picksSettled: number }> {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const now = new Date();

  let resultsFetched = 0;
  // Settle-only pass first: an event can already have a completed
  // MatchResult while still carrying an unsettled Pick — e.g. a pick
  // generated (or re-generated) AFTER its result was fetched, or a
  // manual outcome reset. The main fetch loop below only revisits events
  // whose MatchResult is missing/incomplete, so it would never catch
  // this on its own; this pass costs no external calls, it only reads
  // what's already stored.
  let picksSettled = await settleAlreadyCompletedEvents();

  const events = await prisma.event.findMany({
    where: {
      commenceTime: { lt: now, gte: cutoff },
      OR: [{ matchResult: null }, { matchResult: { completed: false } }],
    },
    include: { sport: { select: { key: true } } },
  });

  // Fixtures too recent to plausibly have a result yet are left for a
  // later cycle entirely — not attempted, not counted toward either
  // source's health. See RESULT_EXPECTED_BUFFER_MS above.
  const dueEvents = events.filter((e) => now.getTime() - e.commenceTime.getTime() >= RESULT_EXPECTED_BUFFER_MS);

  if (dueEvents.length === 0) return { resultsFetched, picksSettled };

  const espnAllowed = await shouldAttempt(ESPN_RESULTS_SOURCE_ID);
  let espnSucceeded = false;
  const unresolved: EventWithSport[] = [];

  if (espnAllowed) {
    for (const event of dueEvents) {
      const ref = ESPN_LEAGUE_BY_SPORT_KEY[event.sport.key];
      if (!ref) {
        unresolved.push(event);
        continue;
      }

      try {
        const result = await resolveEspnMatchResult(ref, event.homeTeam, event.awayTeam, event.commenceTime);
        if (!result) {
          unresolved.push(event);
          continue;
        }

        espnSucceeded = true;
        resultsFetched++;
        await upsertMatchResult(event.id, result, "espn");
        if (result.completed) {
          await prisma.event.update({ where: { id: event.id }, data: { completed: true } });
          picksSettled += await settleEventPicks(event.id, event.homeTeam, event.awayTeam, result);
        }
      } catch (err) {
        console.error(`[resultsIngestion] ESPN lookup failed for event ${event.id} (${event.homeTeam} vs ${event.awayTeam}):`, (err as Error).message);
        unresolved.push(event);
      }
    }
    await recordAttempt(ESPN_RESULTS_SOURCE_ID, espnSucceeded);
  } else {
    unresolved.push(...dueEvents);
  }

  // Fallback: The Odds API /scores, final score only, grouped by sport so
  // it's one call per sport (not per event) — see TheOddsApiProvider's
  // fetchScores for the credit-cost reasoning.
  const oddsProvider = getOddsProvider();
  if (oddsProvider?.fetchScores && unresolved.length > 0) {
    const oddsAllowed = await shouldAttempt(ODDS_RESULTS_SOURCE_ID);
    if (oddsAllowed) {
      let oddsSucceeded = false;
      const bySport = new Map<string, EventWithSport[]>();
      for (const event of unresolved) {
        const list = bySport.get(event.sport.key) ?? [];
        list.push(event);
        bySport.set(event.sport.key, list);
      }

      for (const [sportKey, sportEvents] of bySport) {
        const scores = await oddsProvider.fetchScores(sportKey, daysBack);
        const byExternalId = new Map(scores.map((s) => [s.externalId, s]));

        for (const event of sportEvents) {
          const score = byExternalId.get(event.externalId);
          if (!score || score.homeScore == null || score.awayScore == null) continue;

          oddsSucceeded = true;
          resultsFetched++;
          const result: EspnMatchResult = {
            completed: score.completed,
            finalScoreHome: score.homeScore,
            finalScoreAway: score.awayScore,
            htScoreHome: null,
            htScoreAway: null,
            homeCorners: null,
            awayCorners: null,
            homeCards: null,
            awayCards: null,
            firstScoringTeam: null,
            lastScoringTeam: null,
            penaltyAwarded: null,
          };
          await upsertMatchResult(event.id, result, "the-odds-api");
          if (score.completed) {
            await prisma.event.update({ where: { id: event.id }, data: { completed: true } });
            picksSettled += await settleEventPicks(event.id, event.homeTeam, event.awayTeam, result);
          }
        }
      }
      await recordAttempt(ODDS_RESULTS_SOURCE_ID, oddsSucceeded);
    }
  }

  return { resultsFetched, picksSettled };
}

async function upsertMatchResult(eventId: number, r: EspnMatchResult, source: string): Promise<void> {
  const totalCorners = r.homeCorners != null && r.awayCorners != null ? r.homeCorners + r.awayCorners : null;
  const totalCards = r.homeCards != null && r.awayCards != null ? r.homeCards + r.awayCards : null;

  const existing = await prisma.matchResult.findUnique({ where: { eventId } });
  // A later, richer source (e.g. ESPN resolving after an earlier
  // Odds-API-only fallback row) should win field-by-field rather than
  // being blocked by "already exists" — but never overwrite a populated
  // field with a null one from a weaker source.
  const merged = existing
    ? {
        finalScoreHome: r.finalScoreHome ?? existing.finalScoreHome,
        finalScoreAway: r.finalScoreAway ?? existing.finalScoreAway,
        htScoreHome: r.htScoreHome ?? existing.htScoreHome,
        htScoreAway: r.htScoreAway ?? existing.htScoreAway,
        homeCorners: r.homeCorners ?? existing.homeCorners,
        awayCorners: r.awayCorners ?? existing.awayCorners,
        totalCorners: totalCorners ?? existing.totalCorners,
        homeCards: r.homeCards ?? existing.homeCards,
        awayCards: r.awayCards ?? existing.awayCards,
        totalCards: totalCards ?? existing.totalCards,
        firstScoringTeam: r.firstScoringTeam ?? existing.firstScoringTeam,
        lastScoringTeam: r.lastScoringTeam ?? existing.lastScoringTeam,
        penaltyAwarded: r.penaltyAwarded ?? existing.penaltyAwarded,
        completed: r.completed || existing.completed,
        source: existing.source.includes(source) ? existing.source : `${existing.source}+${source}`,
      }
    : {
        finalScoreHome: r.finalScoreHome,
        finalScoreAway: r.finalScoreAway,
        htScoreHome: r.htScoreHome,
        htScoreAway: r.htScoreAway,
        homeCorners: r.homeCorners,
        awayCorners: r.awayCorners,
        totalCorners,
        homeCards: r.homeCards,
        awayCards: r.awayCards,
        totalCards,
        firstScoringTeam: r.firstScoringTeam,
        lastScoringTeam: r.lastScoringTeam,
        penaltyAwarded: r.penaltyAwarded,
        completed: r.completed,
        source,
      };

  await prisma.matchResult.upsert({
    where: { eventId },
    update: merged,
    create: { eventId, ...merged },
  });
}

async function settleAlreadyCompletedEvents(): Promise<number> {
  const events = await prisma.event.findMany({
    where: {
      matchResult: { completed: true },
      picks: { some: { outcome: null } },
    },
    include: { matchResult: true },
  });

  let settled = 0;
  for (const event of events) {
    if (!event.matchResult) continue;
    settled += await settleEventPicks(event.id, event.homeTeam, event.awayTeam, event.matchResult);
  }
  return settled;
}

// Deliberately looser than EspnMatchResult (finalScoreHome/Away nullable
// here) — settleAlreadyCompletedEvents() passes a stored MatchResult row
// straight through, and Prisma's generated type has every numeric field
// nullable regardless of the `completed` flag's value.
type SettleableResult = {
  finalScoreHome: number | null;
  finalScoreAway: number | null;
  htScoreHome: number | null;
  htScoreAway: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeCards: number | null;
  awayCards: number | null;
  firstScoringTeam: string | null;
  lastScoringTeam: string | null;
  penaltyAwarded: boolean | null;
};

// Only ever called once an event's match is known to be completed (both
// call sites gate on that already), so `completed: true` is hardcoded
// here rather than threaded through — settlePick itself still re-checks
// it defensively.
async function settleEventPicks(eventId: number, homeTeam: string, awayTeam: string, r: SettleableResult): Promise<number> {
  const totalCorners = r.homeCorners != null && r.awayCorners != null ? r.homeCorners + r.awayCorners : null;
  const totalCards = r.homeCards != null && r.awayCards != null ? r.homeCards + r.awayCards : null;
  const forSettlement: MatchResultForSettlement = { ...r, completed: true, totalCorners, totalCards };

  const unsettled = await prisma.pick.findMany({ where: { eventId, outcome: null } });
  let settled = 0;

  for (const pick of unsettled) {
    const outcome = settlePick(pick.marketType, pick.recommendation, homeTeam, awayTeam, forSettlement);
    if (outcome == null) continue; // not ready — leave for next cycle
    await prisma.pick.update({ where: { id: pick.id }, data: { outcome, settledAt: new Date() } });
    settled++;
  }

  return settled;
}
