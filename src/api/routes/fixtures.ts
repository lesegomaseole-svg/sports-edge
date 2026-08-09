/**
 * Fixture selection for the dashboard's main view. Analysis is strictly
 * on-demand (see POST /api/picks/generate) — this route never triggers
 * the AI agent, it just lists fixtures.
 */
import { Router } from "express";
import { prisma } from "../../db/client";

export const fixturesRouter = Router();

// EVERY surviving fixture, ordered by data sufficiency, not confidence —
// fixtureIngestion.ts only ever persists Event rows that already cleared
// the data-sufficiency bar (hasSufficientData/dataScore are computed once
// at ingestion; anything that didn't clear it was never created).
// hasSufficientData: true is still filtered explicitly here (not just
// relied on as an invariant) so this stays correct even against rows that
// predate that field existing, e.g. from before this migration.
//
// TAKE_LIMIT (re-added 2026-08-08, reversing the 2026-08-01 removal;
// raised 10 -> 20 on 2026-08-09): that removal's reasoning — a flat cap
// squeezing out whole leagues once 21+ were tracked — still applies in
// principle, but explicitly requested anyway: with dataScore desc as the
// primary sort, a cap here just means "show the N best-data fixtures
// first," not an arbitrary leaguewide cutoff. hasSufficientData: true is
// still the real data-quality filter (every fixture below the bar was
// never persisted at all — see fixtureIngestion.ts) — this cap only trims
// an already-qualified list down to a manageable dashboard size.
//
// RICH_DATA_SCORE (added 2026-08-08): hasSufficientData only guarantees
// dataScore >= MIN_DATA_SCORE (1 of 2 possible points — see
// fixtureIngestion.ts) — a fixture can clear that bar on EITHER corners/
// cards data OR any sport-wide news existing, not necessarily both. That's
// a deliberately low bar for what gets persisted at all, but too low for
// what the dashboard should hand the model to analyse — a fixture with
// only sport-wide news and no team-specific stats is a much weaker
// analysis candidate than one with both. Restricting to the max score (2)
// here means only fixtures with corners/cards data AND news qualify for
// the dashboard's top list, even though weaker ones still exist in the DB.
const TAKE_LIMIT = 20;
const RICH_DATA_SCORE = 2;

fixturesRouter.get("/top", async (_req, res) => {
  const events = await prisma.event.findMany({
    where: { completed: false, hasSufficientData: true, dataScore: { gte: RICH_DATA_SCORE } },
    include: {
      sport: true,
      picks: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: [{ dataScore: "desc" }, { commenceTime: "asc" }],
    take: TAKE_LIMIT,
  });

  const result = events.map((e) => {
    const pick = e.picks[0];
    return {
      id: e.id,
      homeTeam: e.homeTeam,
      awayTeam: e.awayTeam,
      commenceTime: e.commenceTime,
      dataScore: e.dataScore,
      sport: { id: e.sport.id, key: e.sport.key, title: e.sport.title, group: e.sport.group },
      unanalyzed: !pick,
      pick: pick
        ? {
            id: pick.id,
            market: pick.marketType,
            recommendation: pick.recommendation,
            confidence: pick.confidence,
            reasoning: pick.reasoning,
            modelProvider: pick.modelProvider,
            modelName: pick.modelName,
            createdAt: pick.createdAt,
            // Added 2026-08-01 — see schema.prisma's Pick model comment
            // for why these are stored as JSON strings and parsed here
            // rather than modeled as relations.
            keyFactors: safeJsonArray(pick.keyFactors),
            dataGaps: safeJsonArray(pick.dataGaps),
            dataAvailability: safeJsonObject(pick.dataAvailability),
            // Added 2026-08-04 — see schema.prisma's Pick.dataGapAttributionUncertain
            // comment: true means a reported data gap on this pick can't be
            // attributed to a known cause (not a naming/resolution failure,
            // and no way to check for a disabled provider after the fact).
            dataGapAttributionUncertain: pick.dataGapAttributionUncertain,
            searchesPerformed: safeJsonArray(pick.searchesPerformed),
            runnerUp: safeJsonObject(pick.runnerUp),
            discrepancies: safeJsonArray(pick.discrepancies),
            searchesUsed: pick.searchesUsed,
            degradedAnalysis: pick.degradedAnalysis,
            outcome: pick.outcome,
            settledAt: pick.settledAt,
            critiqued: pick.critiqued,
            preCritiqueRecommendation: pick.preCritiqueRecommendation,
            preCritiqueConfidence: pick.preCritiqueConfidence,
            preCritiqueReasoning: pick.preCritiqueReasoning,
            critiqueNotes: pick.critiqueNotes,
            // Added 2026-08-02 — see schema.prisma's Pick.critiqueAttempted
            // comment: lets the dashboard show "critique attempted but
            // failed" distinctly from "never triggered," instead of both
            // looking identical (critiqued: false).
            critiqueAttempted: pick.critiqueAttempted,
            critiqueAttemptFailed: pick.critiqueAttemptFailed,
            critiqueError: pick.critiqueError,
          }
        : null,
    };
  });

  res.json(result);
});

// Defensive parsing for the JSON-string columns on Pick — a malformed or
// pre-migration ("[]" default, or genuinely corrupt) value should degrade
// to an empty/null result for display, never a 500 on this route.
function safeJsonArray(value: string | null | undefined): unknown[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeJsonObject(value: string | null | undefined): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
