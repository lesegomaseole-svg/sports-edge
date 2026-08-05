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
// No take/limit (removed 2026-08-01 — was hard-capped at 15, a leftover
// from when this app tracked far fewer leagues; with 21 tracked as of
// this writing, that cap was silently squeezing out whole leagues, e.g.
// Eliteserien's fixtures never made a top-15 list dominated by
// earlier-kickoff fixtures from other leagues at the same dataScore).
// Each fixture includes its most recent Pick if one exists, or is
// flagged unanalyzed.
fixturesRouter.get("/top", async (_req, res) => {
  const events = await prisma.event.findMany({
    where: { completed: false, hasSufficientData: true },
    include: {
      sport: true,
      picks: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: [{ dataScore: "desc" }, { commenceTime: "asc" }],
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
