/**
 * Edge check for the EXISTING manual-Analyse flow — added 2026-08-24, in
 * direct response to a real gap the daily-slip funnel work made visible:
 * analyzeEvent.ts's prompt has NEVER compared its recommendation against
 * real market odds (see its own header comment: "There is no odds/market
 * line anywhere in this flow"). A pick can report 85% confidence while
 * the market already prices that outcome at 85% — zero real edge, but
 * indistinguishable from a genuine 85%-confidence pick with real edge
 * behind it, because nothing was ever checked.
 *
 * Deliberately NOT a rewrite of analyzeEvent.ts's prompt or market
 * selection — that flow has real settled-pick history behind it, and
 * this is additive: runs as a SEPARATE follow-up step AFTER a Pick is
 * already saved exactly as it always was, reusing Stage 3's already-
 * verified confirm/adjust/veto machinery (src/lib/slipAnalysis.ts)
 * rather than touching the original prompt at all.
 *
 * Scoped to the market types with a clean, small, well-defined outcome
 * set — every market type that's actually seen real historical picks
 * (match_winner, double_chance, draw_no_bet, total_goals,
 * over_under_bookings, over_under_corners, both_teams_to_score,
 * team_corners) plus a couple of structurally identical ones
 * (second_half_total_goals, odd_even_total_goals). Markets like
 * method_of_victory or winning_margin have no clean, enumerable
 * bookmaker outcome set to de-vig against — getOutcomeLabels returns
 * null for those, and the edge check is skipped rather than forced.
 */
import { prisma } from "../db/client";
import { analyzeSlipCandidate, SlipCandidateForAnalysis } from "./slipAnalysis";

// Same pattern settlement.ts's settleOverUnder already uses for real
// settlement — reused here rather than reinvented, for consistency with
// the one place in this app that's already proven parsing this text
// correctly against real recommendations.
const OVER_UNDER_PATTERN = /(over|under)\s+(\d+(?:\.\d+)?)/i;

function extractThreshold(recommendation: string): number | null {
  const match = recommendation.match(OVER_UNDER_PATTERN);
  return match ? Number(match[2]) : null;
}

function getOutcomeLabels(marketType: string, recommendation: string, homeTeam: string, awayTeam: string): string[] | null {
  switch (marketType) {
    case "match_winner":
      return [`${homeTeam} to win`, "Draw", `${awayTeam} to win`];
    case "double_chance":
      return [`${homeTeam} or Draw`, `${homeTeam} or ${awayTeam}`, `Draw or ${awayTeam}`];
    case "draw_no_bet":
      return [`${homeTeam}, draw no bet`, `${awayTeam}, draw no bet`];
    case "both_teams_to_score":
      return ["Yes", "No"];
    case "odd_even_total_goals":
      return ["Odd", "Even"];
    case "team_corners":
      return [`${homeTeam} to have more corners`, `${awayTeam} to have more corners`];
    case "total_goals": {
      const t = extractThreshold(recommendation);
      return t != null ? [`Over ${t} goals`, `Under ${t} goals`] : null;
    }
    case "second_half_total_goals": {
      const t = extractThreshold(recommendation);
      return t != null ? [`Over ${t} goals in the second half`, `Under ${t} goals in the second half`] : null;
    }
    case "over_under_corners": {
      const t = extractThreshold(recommendation);
      return t != null ? [`Over ${t} corners`, `Under ${t} corners`] : null;
    }
    case "over_under_bookings": {
      const t = extractThreshold(recommendation);
      return t != null ? [`Over ${t} cards`, `Under ${t} cards`] : null;
    }
    default:
      return null; // no clean enumerable outcome set for this market type — edge check skipped, not forced
  }
}

export interface EdgeCheckResult {
  applicable: boolean;
  skippedReason: string | null;
  devigedMarketProbability: number | null;
  price: number | null;
  edge: number | null; // Pick.confidence - devigedMarketProbability
  vetoed: boolean;
  vetoReason: string | null;
  note: string; // human-readable summary for the dashboard
}

/**
 * Runs the edge check for one already-saved Pick and returns the result
 * — does NOT write to the DB itself (see runAndSaveEdgeCheck below for
 * that), so this stays testable/callable independent of persistence.
 */
export async function checkPickEdge(pickId: number): Promise<EdgeCheckResult> {
  const pick = await prisma.pick.findUniqueOrThrow({ where: { id: pickId }, include: { event: { include: { sport: true } } } });

  const outcomeLabels = getOutcomeLabels(pick.marketType, pick.recommendation, pick.event.homeTeam, pick.event.awayTeam);
  if (!outcomeLabels) {
    return {
      applicable: false,
      skippedReason: `No clean, enumerable bookmaker outcome set for market type "${pick.marketType}" — edge check not applicable.`,
      devigedMarketProbability: null,
      price: null,
      edge: null,
      vetoed: false,
      vetoReason: null,
      note: "Edge check not applicable for this market type.",
    };
  }

  const candidate: SlipCandidateForAnalysis = {
    eventId: pick.eventId,
    sportKey: pick.event.sport.key,
    leagueTitle: pick.event.sport.title,
    homeTeam: pick.event.homeTeam,
    awayTeam: pick.event.awayTeam,
    commenceTime: pick.event.commenceTime,
    marketType: pick.marketType,
    recommendation: pick.recommendation,
    marketOutcomeLabels: outcomeLabels,
    baselineProbability: pick.confidence, // the ALREADY-MADE pick's own stated confidence is what's being checked here, not a Poisson estimate
  };

  const analysis = await analyzeSlipCandidate(candidate);

  let devigedMarketProbability: number | null = null;
  let price: number | null = null;
  if (analysis.oddsFound) {
    const { devigMarket } = await import("./devig");
    const devigged = devigMarket(analysis.oddsFound);
    const match = devigged.outcomes.find((o) => o.name.toLowerCase().trim() === pick.recommendation.toLowerCase().trim());
    if (match) {
      devigedMarketProbability = match.devigedProbability;
      price = match.price;
    }
  }

  const edge = devigedMarketProbability != null ? pick.confidence - devigedMarketProbability : null;

  let note: string;
  if (analysis.veto) {
    note = `Edge check vetoed: ${analysis.vetoReason ?? "no reason given"}`;
  } else if (edge == null) {
    note = "Could not find matching current odds for this exact recommendation.";
  } else {
    const pct = (edge * 100).toFixed(1);
    note = edge > 0 ? `+${pct}pp real edge over the de-vigged market price.` : `${pct}pp — no real edge over the de-vigged market price.`;
  }

  return {
    applicable: true,
    skippedReason: null,
    devigedMarketProbability,
    price,
    edge,
    vetoed: analysis.veto,
    vetoReason: analysis.vetoReason,
    note,
  };
}

/**
 * checkPickEdge + persist the result onto the Pick row. Errors are caught
 * and logged, not rethrown — this is a best-effort enrichment step run
 * AFTER the real pick is already saved and usable; a failure here (a bad
 * search, a CLI hiccup) should never take down or roll back an otherwise-
 * good pick, same principle as the existing critique pass's own
 * catch-and-continue behavior in analyzeEvent.ts.
 */
export async function runAndSaveEdgeCheck(pickId: number): Promise<void> {
  try {
    const result = await checkPickEdge(pickId);
    await prisma.pick.update({
      where: { id: pickId },
      data: {
        edgeCheckApplicable: result.applicable,
        edgeCheckDevigedProbability: result.devigedMarketProbability,
        edgeCheckPrice: result.price,
        edgeCheckEdge: result.edge,
        edgeCheckVetoed: result.vetoed,
        edgeCheckVetoReason: result.vetoReason,
        edgeCheckNote: result.note,
        edgeCheckAt: new Date(),
      },
    });
  } catch (err) {
    console.error(`[pickEdgeCheck] failed for pick ${pickId}:`, (err as Error).message);
  }
}
