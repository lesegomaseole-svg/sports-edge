/**
 * Daily-slip funnel orchestration — added 2026-08-24. Ties Stages 1-4
 * together against real data: gathers upcoming fixtures + Poisson
 * baselines from the DB/providers, shortlists, runs Stage 3 (LLM confirm/
 * adjust/veto + real odds), applies the EV gate, and builds both the
 * combo and singles outputs. Every module this calls was independently
 * verified before being wired together here — see each module's own
 * commit for how.
 *
 * Persists EVERY leg that reached Stage 3 to DailySlipLeg, not just ones
 * that made the final slip — see that model's own schema comment for why
 * (auditing NO_QUALIFYING_SLIP days, eventually checking whether the EV
 * gate itself is well-calibrated once real results exist).
 */
import { prisma } from "../db/client";
import { FootballDataCoUkProvider, TeamGoalProfileWithMeta } from "../providers/stats/FootballDataCoUkProvider";
import { expectedGoals, buildScoreGrid, matchWinnerProbabilities, totalGoalsOverProbability, bothTeamsToScoreProbability, ScoreGrid } from "./poissonModel";
import { FixtureCandidate, MarketEstimate, buildShortlist, ShortlistConfig, DEFAULT_SHORTLIST_CONFIG, ShortlistedCandidate } from "./shortlist";
import { analyzeSlipCandidate, SlipCandidateForAnalysis, SlipLegAnalysis } from "./slipAnalysis";
import { devigMarket } from "./devig";
import { DEFAULT_EDGE_THRESHOLD } from "./evGate";
import { buildCombo, buildSinglesRecommendations, SlipLeg, SlipOutcome, ComboConfig, DEFAULT_COMBO_CONFIG } from "./comboBuilder";

const footballDataCoUk = new FootballDataCoUkProvider();
const TOTAL_GOALS_THRESHOLD = 2.5;
// Below the default 0.6 shortlist floor on purpose — a fixture with no
// baseline model at all should never clear the completeness gate, but
// still gets recorded with a real reason rather than silently vanishing.
const NO_BASELINE_COMPLETENESS = 0.3;
const HAS_BASELINE_COMPLETENESS = 0.9;

export interface DailySlipRunResult {
  runDate: string;
  candidatesConsidered: number;
  shortlistReasons: string[];
  legsEvaluatedInStage3: number;
  legsFailedStage3: number;
  comboResult: SlipOutcome;
  singlesRecommendations: SlipLeg[];
}

interface FixtureRow {
  id: number;
  sportKey: string;
  leagueTitle: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: Date;
}

/** marketType -> every outcome label a bookmaker would show for it. Recommendation text produced by deriveMarketEstimates below MUST come from this same list — never generated separately — so the later devig-outcome lookup can match by exact string. */
function marketOutcomeLabels(marketType: string, homeTeam: string, awayTeam: string): string[] {
  switch (marketType) {
    case "match_winner":
      return [`${homeTeam} to win`, "Draw", `${awayTeam} to win`];
    case "total_goals":
      return [`Over ${TOTAL_GOALS_THRESHOLD} goals`, `Under ${TOTAL_GOALS_THRESHOLD} goals`];
    case "both_teams_to_score":
      return ["Yes", "No"];
    default:
      return [];
  }
}

function deriveMarketEstimates(grid: ScoreGrid, homeTeam: string, awayTeam: string): MarketEstimate[] {
  const estimates: MarketEstimate[] = [];
  const [homeWinLabel, drawLabel, awayWinLabel] = marketOutcomeLabels("match_winner", homeTeam, awayTeam);
  const [overLabel, underLabel] = marketOutcomeLabels("total_goals", homeTeam, awayTeam);
  const [yesLabel, noLabel] = marketOutcomeLabels("both_teams_to_score", homeTeam, awayTeam);

  const mw = matchWinnerProbabilities(grid);
  if (mw.homeWin >= mw.draw && mw.homeWin >= mw.awayWin) {
    estimates.push({ marketType: "match_winner", recommendation: homeWinLabel, baselineProbability: mw.homeWin });
  } else if (mw.awayWin >= mw.draw) {
    estimates.push({ marketType: "match_winner", recommendation: awayWinLabel, baselineProbability: mw.awayWin });
  } else {
    estimates.push({ marketType: "match_winner", recommendation: drawLabel, baselineProbability: mw.draw });
  }

  const over = totalGoalsOverProbability(grid, TOTAL_GOALS_THRESHOLD);
  estimates.push(
    over >= 0.5
      ? { marketType: "total_goals", recommendation: overLabel, baselineProbability: over }
      : { marketType: "total_goals", recommendation: underLabel, baselineProbability: 1 - over }
  );

  const btts = bothTeamsToScoreProbability(grid);
  estimates.push(
    btts >= 0.5
      ? { marketType: "both_teams_to_score", recommendation: yesLabel, baselineProbability: btts }
      : { marketType: "both_teams_to_score", recommendation: noLabel, baselineProbability: 1 - btts }
  );

  return estimates;
}

async function gatherCandidates(): Promise<{ candidates: FixtureCandidate[]; rows: Map<number, FixtureRow> }> {
  const events = await prisma.event.findMany({
    where: { completed: false },
    include: { sport: true },
    orderBy: { commenceTime: "asc" },
  });

  const candidates: FixtureCandidate[] = [];
  const rows = new Map<number, FixtureRow>();
  const rateCache = new Map<string, Awaited<ReturnType<typeof footballDataCoUk.getLeagueTeamRates>>>();

  for (const e of events) {
    const row: FixtureRow = {
      id: e.id,
      sportKey: e.sport.key,
      leagueTitle: e.sport.title,
      homeTeam: e.homeTeam,
      awayTeam: e.awayTeam,
      commenceTime: e.commenceTime,
    };
    rows.set(e.id, row);

    if (!rateCache.has(e.sport.key)) {
      rateCache.set(e.sport.key, await footballDataCoUk.getLeagueTeamRates(e.sport.key));
    }
    const rates = rateCache.get(e.sport.key);

    const completenessReasons: string[] = [];
    let markets: MarketEstimate[] = [];
    let dataCompleteness = NO_BASELINE_COMPLETENESS;

    if (!rates) {
      completenessReasons.push("No Poisson baseline available for this league (not covered by football-data.co.uk, or currently unreachable).");
    } else {
      const homeProfile: TeamGoalProfileWithMeta | null = footballDataCoUk.findTeamRate(rates.home, e.homeTeam);
      const awayProfile: TeamGoalProfileWithMeta | null = footballDataCoUk.findTeamRate(rates.away, e.awayTeam);
      if (!homeProfile || !awayProfile) {
        completenessReasons.push(`Insufficient recent-match history for ${!homeProfile ? e.homeTeam : e.awayTeam} to compute a reliable baseline.`);
      } else {
        const { lambdaHome, lambdaAway } = expectedGoals(homeProfile, awayProfile, rates.league);
        const grid = buildScoreGrid(lambdaHome, lambdaAway);
        markets = deriveMarketEstimates(grid, e.homeTeam, e.awayTeam);
        dataCompleteness = HAS_BASELINE_COMPLETENESS;
      }
    }

    candidates.push({
      eventId: e.id,
      sportKey: e.sport.key,
      leagueTitle: e.sport.title,
      homeTeam: e.homeTeam,
      awayTeam: e.awayTeam,
      dataCompleteness,
      completenessReasons,
      markets,
    });
  }

  return { candidates, rows };
}

export interface RunDailySlipFunnelConfig {
  shortlist?: ShortlistConfig;
  combo?: ComboConfig;
  edgeThreshold?: number;
}

export async function runDailySlipFunnel(config: RunDailySlipFunnelConfig = {}): Promise<DailySlipRunResult> {
  const runDate = new Date().toISOString().slice(0, 10);
  const edgeThreshold = config.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD;

  const { candidates, rows } = await gatherCandidates();
  const shortlistResult = buildShortlist(candidates, config.shortlist ?? DEFAULT_SHORTLIST_CONFIG);

  if (!shortlistResult.worthAttemptingSlip) {
    return {
      runDate,
      candidatesConsidered: candidates.length,
      shortlistReasons: shortlistResult.reasons,
      legsEvaluatedInStage3: 0,
      legsFailedStage3: 0,
      comboResult: { type: "NO_QUALIFYING_SLIP", reason: shortlistResult.reasons.join(" ") },
      singlesRecommendations: [],
    };
  }

  const gatedLegs: SlipLeg[] = [];
  let legsFailedStage3 = 0;

  for (const shortlisted of shortlistResult.shortlist) {
    const row = rows.get(shortlisted.candidate.eventId);
    if (!row) continue; // shouldn't happen — candidates all came from rows in the first place

    const outcomeLabels = marketOutcomeLabels(shortlisted.bestMarket.marketType, row.homeTeam, row.awayTeam);
    const slipCandidate: SlipCandidateForAnalysis = {
      eventId: row.id,
      sportKey: row.sportKey,
      leagueTitle: row.leagueTitle,
      homeTeam: row.homeTeam,
      awayTeam: row.awayTeam,
      commenceTime: row.commenceTime,
      marketType: shortlisted.bestMarket.marketType,
      recommendation: shortlisted.bestMarket.recommendation,
      marketOutcomeLabels: outcomeLabels,
      baselineProbability: shortlisted.bestMarket.baselineProbability,
    };

    let analysis: SlipLegAnalysis;
    try {
      analysis = await analyzeSlipCandidate(slipCandidate);
    } catch (err) {
      legsFailedStage3++;
      console.error(`[dailySlip] Stage 3 analysis failed for event ${row.id}:`, (err as Error).message);
      continue; // one failed leg shouldn't kill the whole run
    }

    const persisted = await persistLeg(runDate, row.id, shortlisted, analysis, edgeThreshold);
    if (persisted.passedEvGate && persisted.price != null && persisted.devigedMarketProbability != null && persisted.edge != null) {
      gatedLegs.push({
        eventId: row.id,
        marketType: shortlisted.bestMarket.marketType,
        recommendation: shortlisted.bestMarket.recommendation,
        adjustedProbability: analysis.adjustedProbability,
        devigedMarketProbability: persisted.devigedMarketProbability,
        price: persisted.price,
        edge: persisted.edge,
        passed: true,
        leagueTitle: row.leagueTitle,
        homeTeam: row.homeTeam,
        awayTeam: row.awayTeam,
      });
    }
  }

  const comboResult = buildCombo(gatedLegs, config.combo ?? DEFAULT_COMBO_CONFIG);
  const singlesRecommendations = buildSinglesRecommendations(gatedLegs);

  if (comboResult.type === "SLIP") {
    const includedEventIds = comboResult.slip.legs.map((l) => l.eventId);
    await prisma.dailySlipLeg.updateMany({
      where: { runDate, eventId: { in: includedEventIds } },
      data: { includedInCombo: true },
    });
  }

  return {
    runDate,
    candidatesConsidered: candidates.length,
    shortlistReasons: shortlistResult.reasons,
    legsEvaluatedInStage3: shortlistResult.shortlist.length,
    legsFailedStage3,
    comboResult,
    singlesRecommendations,
  };
}

async function persistLeg(
  runDate: string,
  eventId: number,
  shortlisted: ShortlistedCandidate,
  analysis: SlipLegAnalysis,
  edgeThreshold: number
): Promise<{ passedEvGate: boolean; devigedMarketProbability: number | null; price: number | null; edge: number | null }> {
  let devigedMarketProbability: number | null = null;
  let price: number | null = null;

  if (analysis.oddsFound) {
    const devigged = devigMarket(analysis.oddsFound);
    const matchOutcome = devigged.outcomes.find((o) => o.name.toLowerCase().trim() === shortlisted.bestMarket.recommendation.toLowerCase().trim());
    if (matchOutcome) {
      devigedMarketProbability = matchOutcome.devigedProbability;
      price = matchOutcome.price;
    }
  }

  const edge = devigedMarketProbability != null ? analysis.adjustedProbability - devigedMarketProbability : null;
  const passedEvGate = !analysis.veto && price != null && edge != null && edge > edgeThreshold;

  await prisma.dailySlipLeg.create({
    data: {
      runDate,
      eventId,
      marketType: shortlisted.bestMarket.marketType,
      recommendation: shortlisted.bestMarket.recommendation,
      baselineProbability: shortlisted.bestMarket.baselineProbability,
      adjustedProbability: analysis.adjustedProbability,
      devigedMarketProbability,
      price,
      edge,
      veto: analysis.veto,
      vetoReason: analysis.vetoReason,
      passedEvGate,
      reasoning: analysis.reasoning,
      dataGaps: JSON.stringify(analysis.dataGaps),
    },
  });

  return { passedEvGate, devigedMarketProbability, price, edge };
}
