/**
 * Recomputes LeagueBaseRate for every sport with at least one completed
 * MatchResult — a rolling context stat (goals/match, home/draw/away %,
 * corners/match, cards/match) computed entirely from data this app
 * already ingests via resultsIngestion.ts, not a new external source.
 * Called after every results ingestion cycle (see resultsScheduler.ts) —
 * cheap (a handful of in-process aggregations, no network calls), so
 * recomputing on every cycle rather than a separate schedule is simplest
 * and keeps it always current with whatever results just came in.
 */
import { prisma } from "../db/client";

export async function recomputeLeagueBaseRates(): Promise<{ leaguesUpdated: number }> {
  const sports = await prisma.sport.findMany({
    where: { events: { some: { matchResult: { completed: true } } } },
    select: { id: true },
  });

  let leaguesUpdated = 0;
  for (const sport of sports) {
    const results = await prisma.matchResult.findMany({
      where: { completed: true, event: { sportId: sport.id } },
      select: { finalScoreHome: true, finalScoreAway: true, homeCorners: true, awayCorners: true, homeCards: true, awayCards: true },
    });

    const withGoals = results.filter((r) => r.finalScoreHome != null && r.finalScoreAway != null);
    const withCornersCards = results.filter((r) => r.homeCorners != null && r.awayCorners != null && r.homeCards != null && r.awayCards != null);

    if (withGoals.length === 0) continue; // nothing usable yet for this league

    const totalGoals = withGoals.reduce((sum, r) => sum + r.finalScoreHome! + r.finalScoreAway!, 0);
    const homeWins = withGoals.filter((r) => r.finalScoreHome! > r.finalScoreAway!).length;
    const draws = withGoals.filter((r) => r.finalScoreHome === r.finalScoreAway).length;
    const awayWins = withGoals.filter((r) => r.finalScoreAway! > r.finalScoreHome!).length;

    const cornersPerMatch =
      withCornersCards.length > 0 ? withCornersCards.reduce((sum, r) => sum + r.homeCorners! + r.awayCorners!, 0) / withCornersCards.length : null;
    const cardsPerMatch =
      withCornersCards.length > 0 ? withCornersCards.reduce((sum, r) => sum + r.homeCards! + r.awayCards!, 0) / withCornersCards.length : null;

    await prisma.leagueBaseRate.upsert({
      where: { sportId: sport.id },
      update: {
        goalsPerMatch: totalGoals / withGoals.length,
        homeWinPct: homeWins / withGoals.length,
        drawPct: draws / withGoals.length,
        awayWinPct: awayWins / withGoals.length,
        resultsSampleSize: withGoals.length,
        cornersPerMatch,
        cardsPerMatch,
        cornersCardsSampleSize: withCornersCards.length,
      },
      create: {
        sportId: sport.id,
        goalsPerMatch: totalGoals / withGoals.length,
        homeWinPct: homeWins / withGoals.length,
        drawPct: draws / withGoals.length,
        awayWinPct: awayWins / withGoals.length,
        resultsSampleSize: withGoals.length,
        cornersPerMatch,
        cardsPerMatch,
        cornersCardsSampleSize: withCornersCards.length,
      },
    });
    leaguesUpdated++;
  }

  return { leaguesUpdated };
}
