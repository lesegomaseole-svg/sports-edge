/**
 * Core recommendation pipeline for one event. Soccer-only (see
 * MARKET_MENU below and src/db/seed.ts) — triggered strictly on-demand,
 * only ever called from POST /api/picks/generate, never from a scheduler.
 *
 * The AI evaluates every market it has real supporting data for, compares
 * signal strength across them, and picks whichever one stands out most —
 * or "none" if nothing clears a reasonable confidence bar. It is NOT told
 * which market to analyze upfront.
 *
 * No structured odds feed as of 2026-08-03 (see fixtureIngestion.ts's file
 * header for why: The Odds API got blocked at the network level on the
 * dev machine, and since fixture discovery was fully coupled to it at the
 * time, fixtures moved to ESPN and odds moved entirely to the model's own
 * PRIMARY web search instead of being re-coupled to a different
 * structured source). There's also no spread/handicap LINE regardless
 * (the removed TheOddsApiProvider integration was h2h-only), so goals/
 * corners/cards markets stay directional or use the conventional
 * threshold categories documented below — never a fabricated specific
 * number.
 *
 * Numbers in market descriptions (total_goals' 0.5/1.5/2.5/3.5/4.5, and
 * the corners/cards thresholds) are CONVENTIONAL CATEGORY LABELS, not
 * fabricated lines — soccer betting markets are structured around these
 * standard thresholds industry-wide, so naming one is choosing a
 * category, not inventing a number. The corners (8.5-11.5) and cards
 * (2.5-4.5) threshold ranges are this app's own reasonable convention,
 * since the task spec gave an explicit standard only for goals —
 * documented here for that reason.
 *
 * Context gathered once per event, best-effort, and assembled into the
 * PROMPT as VERIFICATION DATA (see buildEventAnalysisPrompt) — NOT the
 * primary narrative as of the 2026-08-01 search-primary restructure
 * (below). Fetched in this order in code (prompt order differs, see the
 * function itself):
 *   1. Stats — every enabled StatsProvider (corners/cards from
 *      EspnMatchStatsProvider and SofaScoreRapidApiProvider, team
 *      form/standings from ApiFootballStatsProvider/SportMonksStatsProvider/
 *      FootballDataStatsProvider), for both teams.
 *   2. Weather — kickoff-time forecast for the home team's venue city
 *      (OpenWeatherMapProvider), called out as relevant to goals/corners.
 *   3. Recent news for the sport.
 *
 * FEEDBACK LOOP (added 2026-08-01): the model's own past picks are
 * settled and graded (settlement.ts -> Pick.outcome) and aggregated into
 * a calibration report (calibration.ts). That report already existed as
 * reporting-only, surfaced on the dashboard's Track Record panel for a
 * human — this closes the loop by also feeding it into the NEXT analysis
 * as prompt context (buildPerformanceFeedbackBlock), so a confidence band
 * this app has empirically run overconfident in gets an explicit nudge
 * toward more conservative confidence next time, and vice versa. Gated by
 * the exact same ~30-graded-pick reliability threshold the calibration
 * report itself uses — with a small sample this block says so plainly and
 * tells the model not to use it, rather than handing over a number that
 * isn't statistically meaningful yet.
 *
 * PRIMARY/VERIFICATION FLIP (2026-08-01): web search was originally a
 * gap-filler, triggered only when the structured data above was
 * missing/thin/contradictory. It's now flipped — search runs FIRST and is
 * the primary information-gathering step (explicitly instructed to cover
 * recent form, injuries/lineup news, head-to-head, current odds, and
 * corners/cards tendencies), and everything fetched above is reframed as
 * VERIFICATION DATA, presented specifically to cross-check search
 * findings rather than as the narrative itself. The model is required to
 * state, per material fact, whether search and structured data AGREE,
 * DISAGREE, or only one had it — agreement raises confidence in that
 * fact, disagreement must be flagged (see the `discrepancies` output
 * field and Discrepancy in AgentProvider.ts) with a stated reason for
 * which value was preferred, and a structured-only fact (search found
 * nothing) is used but labeled a source of last resort, not primary.
 *
 * Anti-bias grounding (added 2026-07-31/08-01, several layers): the
 * prompt tells the model to reason only from the data handed to it here,
 * not from general/training knowledge about these teams (which may be
 * stale — rosters, managers, and form change constantly, and the model's
 * training cutoff predates "now" by an unknown margin) — a confident
 * answer built on outdated priors about a "big" club is worse than an
 * honest "none". It ALSO explicitly tells the model a numeric market
 * price isn't inherently more reliable than qualitative evidence just
 * because it's precise. The model is asked to prefer a market
 * corroborated by more than one independent source, and its confidence
 * score is expected to reflect that (multiple sources agreeing = high
 * confidence; one weak/ambiguous/contradicted signal = low).
 *
 * Output is always saved as an advisory Pick, with the model's own choice
 * of market stored in Pick.marketType — an output now, not an input, and
 * validated against MARKET_MENU (coerced to "none" if the model returns
 * something off-menu, or if the event's sport isn't soccer). Nothing here
 * executes a bet.
 */
import { prisma } from "../db/client";
import { getAgentProvider } from "../agents";
import { StatsProvider } from "../providers/stats/StatsProvider";
import { getEnabledStatsProviders } from "../providers/stats";
import { getEnabledWeatherProvider } from "../providers/weather";
import { ESPN_LEAGUE_BY_SPORT_KEY, resolveHomeVenueCity } from "../providers/espn/espnLeagueMap";
import { shouldAttempt, recordAttempt } from "./dataSourceHealth";
import { mentionsTeam } from "./teamNameMatch";
import { captureOddsAtPick } from "./clv";
import { shouldRunCritique, runCritiquePass } from "./critiquePass";
import { computeCalibrationReport } from "./calibration";

const statsProviders = getEnabledStatsProviders();
const weatherProvider = getEnabledWeatherProvider();

// Priority: football-data.org's form/standings data is genuinely current;
// API-Football's free plan is capped at a stale season (see
// ApiFootballStatsProvider's file header). Wherever football-data covers
// a league, api-football is skipped entirely for it rather than merged in
// alongside — see buildStatsBlock. Identified by name rather than a
// tighter type, since StatsProvider itself doesn't distinguish "form"
// sources from "corners/cards" ones (espn-match-stats) or narrow-coverage
// ones (sportmonks), which aren't part of this priority rule at all.
const FOOTBALL_DATA_PROVIDER = statsProviders.find((p) => p.name === "football-data");
const API_FOOTBALL_PROVIDER = statsProviders.find((p) => p.name === "api-football");

const NONE_MARKET = "none";

interface MarketMenuItem {
  id: string;
  description: string;
}

// The full soccer market vocabulary — applies to every league in
// ESPN_LEAGUE_BY_SPORT_KEY (soccer-only). Deliberately excludes: any
// handicap market (no real bookmaker LINE to reference — odds here are
// h2h win-probability only — so any spread number would be fabricated),
// correct score / HT correct score / scorecast / exact goal count / time
// of first goal / own goal (too speculative to analyze honestly from
// season-level stats), race-to-X corners / first card (need in-match
// sequencing data this app doesn't have), any player-level market (needs
// a player-stats dimension not built), and to-qualify / tournament-winner
// (season/knockout-level, doesn't fit a single-fixture analysis).
const SOCCER_MARKET_MENU: MarketMenuItem[] = [
  {
    id: "match_winner",
    description:
      'Three-way result (1X2) — home win, draw, or away win. Do NOT force a binary choice; a draw is a fully valid, common outcome and should be picked when it\'s genuinely your best read. Weigh the consensus odds heavily here if present. E.g. "Arsenal to win" or "Draw".',
  },
  {
    id: "double_chance",
    description:
      'A combined two-outcome bet covering 2 of the 3 possible results, e.g. "Arsenal or Draw". Lower risk than match_winner — use when you have a moderate lean but not a strong enough single-outcome view.',
  },
  {
    id: "draw_no_bet",
    description:
      'Pick a team to win with the draw scenario excluded entirely — use when you lean toward a team but see a real enough chance of a draw that you don\'t want to bet against it outright. E.g. "Arsenal, draw no bet".',
  },
  {
    id: "total_goals",
    description:
      'Over/Under ONE standard goals threshold: 0.5, 1.5, 2.5, 3.5, or 4.5 — e.g. "Over 2.5 goals". These are conventional match-total categories, not a fabricated line, but only pick this if both teams\' attacking/defensive form genuinely supports a direction.',
  },
  {
    id: "both_teams_to_score",
    description: 'Whether both teams will score at least once. Recommendation exactly "Yes" or "No".',
  },
  {
    id: "team_total_goals",
    description:
      'A directional lean on ONE specific team\'s own goal output, same standard thresholds as total_goals, e.g. "Arsenal Over 1.5 goals". Use when one team\'s attack or the opponent\'s defense stands out more than the overall match total does.',
  },
  {
    id: "clean_sheet",
    description:
      'Name the team you think concedes zero goals, e.g. "Arsenal clean sheet". Only pick this with a real read on one side\'s defense or the opponent\'s weak attack.',
  },
  {
    id: "winning_margin",
    description:
      'A margin bucket for the winning side, e.g. "Arsenal by 2+ goals" or "Arsenal by 1 goal". Only pick this with a strong quality-gap read, not a close matchup.',
  },
  {
    id: "half_time_result",
    description: "Three-way result (home/draw/away) at halftime only — same logic as match_winner but for the first 45 minutes.",
  },
  {
    id: "half_time_full_time",
    description:
      'Combined halftime + fulltime result, e.g. "Draw/Arsenal" (drawing at half, Arsenal winning full-time). Only pick this with a specific read on how the match is likely to unfold, not just who wins overall.',
  },
  {
    id: "goal_in_both_halves",
    description: 'Whether at least one goal is scored in EACH half. Recommendation exactly "Yes" or "No".',
  },
  {
    id: "highest_scoring_half",
    description: 'Which half has more goals — "First half" or "Second half".',
  },
  {
    id: "total_corners",
    description:
      'A directional lean on overall match corner count — high vs low — described in words only, e.g. "Expect a high number of corners". No specific number.',
  },
  {
    id: "over_under_corners",
    description:
      'Over/Under a specific corner threshold in the conventional 8.5-11.5 range, e.g. "Over 9.5 corners". Only pick this with real corner-count data supporting a direction, not a guess.',
  },
  {
    id: "team_corners",
    description: 'Name the team you think wins the corner count, e.g. "Arsenal to have more corners".',
  },
  {
    id: "total_cards",
    description: "A directional lean on overall match cards/bookings — high vs low — described in words only. No specific number.",
  },
  {
    id: "over_under_bookings",
    description:
      'Over/Under a specific cards threshold in the conventional 2.5-4.5 range, e.g. "Over 3.5 cards". Only pick this with real cards/fouls data supporting a direction, not a guess.',
  },
  {
    id: "team_cards",
    description: "Name the team you think picks up more cards/bookings.",
  },
  {
    id: "odd_even_total_goals",
    description: 'Whether total goals in the match will be odd or even. Recommendation exactly "Odd" or "Even".',
  },
  {
    id: "method_of_victory",
    description:
      'A qualitative read on HOW the win happens, e.g. "Arsenal to win from behind" or "Arsenal to win via a dominant defensive display" — narrative, grounded in the teams\' patterns, no numbers.',
  },
  {
    id: "team_to_score_first",
    description: "Name the team you think scores first.",
  },
  {
    id: "team_to_score_last",
    description: "Name the team you think scores last.",
  },
  {
    id: "penalty_awarded",
    description: "Whether a penalty will be awarded in the match. Recommendation exactly \"Yes\" or \"No\".",
  },
];

export async function analyzeEvent(eventId: number) {
  const event = await prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    include: { sport: true },
  });

  const newsBlock = await buildNewsBlock(event.sport.key, event.homeTeam, event.awayTeam);

  const statsBlock = await buildStatsBlock(event.homeTeam, event.awayTeam, event.sport.key);
  const weatherBlock = await buildWeatherBlock(event.homeTeam, event.sport.key, event.commenceTime);
  const leagueContextBlock = await buildLeagueContextBlock(event.sportId, event.sport.title);
  const performanceFeedbackBlock = await buildPerformanceFeedbackBlock(event.sport.title);
  const marketMenu = ESPN_LEAGUE_BY_SPORT_KEY[event.sport.key] ? SOCCER_MARKET_MENU : [];

  const prompt = buildEventAnalysisPrompt({
    sport: event.sport.title,
    homeTeam: event.homeTeam,
    awayTeam: event.awayTeam,
    commenceTime: event.commenceTime.toISOString(),
    currentDate: new Date().toISOString().slice(0, 10),
    statsBlock,
    weatherBlock,
    leagueContextBlock,
    performanceFeedbackBlock,
    newsBlock,
    marketMenu,
  });

  const agent = getAgentProvider();
  const originalResult = await agent.analyze(prompt);
  const originalMarket = coerceMarket(originalResult.market, marketMenu, event.sport.key);

  // Selective second pass (added 2026-08-01) — only for picks whose
  // ORIGINAL confidence cleared CRITIQUE_CONFIDENCE_THRESHOLD. finalResult
  // becomes the critique's own output when it ran (recommendation/
  // confidence/reasoning/degradedAnalysis all update to match), so what's
  // persisted below always reflects whichever pass actually produced the
  // saved pick.
  let finalResult = originalResult;
  let finalMarket = originalMarket;
  let critiqued = false;
  let critiqueNotes: string | null = null;
  // critiqueAttempted/critiqueAttemptFailed/critiqueError (added
  // 2026-08-02): distinguishes "confidence never cleared the critique
  // threshold" from "cleared it, but runCritiquePass errored and the
  // pre-critique result was kept" — previously both looked identical
  // (critiqued=false) from the Pick record alone. See schema.prisma's
  // comment on these fields.
  const critiqueAttempted = shouldRunCritique(originalResult.confidence);
  let critiqueAttemptFailed = false;
  let critiqueError: string | null = null;

  if (critiqueAttempted) {
    try {
      const critique = await runCritiquePass(agent, prompt, originalResult);
      finalResult = critique.final;
      finalMarket = coerceMarket(finalResult.market, marketMenu, event.sport.key);
      critiqueNotes = critique.critiqueNotes;
      critiqued = true;
    } catch (err) {
      critiqueAttemptFailed = true;
      critiqueError = (err as Error).message;
      console.error(`[analyzeEvent] critique pass failed for event ${eventId}, keeping original analysis:`, critiqueError);
    }
  }

  // CLV capture (added 2026-08-03) — best-effort, never fails the pick:
  // a live odds check for the specific side this pick took, right now,
  // while the recommendation is fresh. See clv.ts's file header for why
  // this is a live on-demand fetch, not a read from the old (now inert)
  // OddsSnapshot table.
  const clvResult = await captureOddsAtPick(
    event.sport.key,
    finalMarket,
    finalResult.recommendation,
    event.homeTeam,
    event.awayTeam,
    event.commenceTime
  );

  // upsert, not create (added 2026-08-02 — see Pick.eventId's @unique
  // comment in schema.prisma): re-analysing a fixture replaces its one
  // Pick row rather than inserting a second, correlated one. The `update`
  // branch intentionally mirrors `create` field-for-field — a
  // re-analysis is a fresh result, not a merge with the old row, so
  // outcome/settledAt/critique-tracking from a PRIOR analysis (which
  // graded a possibly-different recommendation) must reset alongside
  // everything else, not linger against a recommendation that no longer
  // exists. createdAt is bumped explicitly on update since Prisma's
  // @default(now()) only applies on insert. CLV fields reset the same
  // way — a re-analysis is a fresh pick with its own fresh opening price,
  // not a continuation of the old one's CLV cycle.
  const pickData = {
    marketType: finalMarket,
    recommendation: finalResult.recommendation,
    confidence: finalResult.confidence,
    reasoning: finalResult.reasoning,
    modelProvider: agent.name,
    modelName: agent.modelName,
    // JSON-stringified — see schema.prisma's Pick model comment for why
    // (SQLite has no native JSON column type; these are read back with
    // JSON.parse wherever they're surfaced, e.g. the picks API route).
    keyFactors: JSON.stringify(finalResult.keyFactors),
    dataGaps: JSON.stringify(finalResult.dataGaps),
    dataAvailability: JSON.stringify(finalResult.dataAvailability),
    searchesPerformed: JSON.stringify(finalResult.searchesPerformed),
    runnerUp: finalResult.runnerUp ? JSON.stringify(finalResult.runnerUp) : null,
    discrepancies: JSON.stringify(finalResult.discrepancies),
    // Sum of both passes' searches when critique ran — both are real
    // searches against the same underlying pick (API-billed or
    // subscription-billed depending on provider).
    searchesUsed: (originalResult.searchesUsed ?? 0) + (critiqued ? (finalResult.searchesUsed ?? 0) : 0),
    degradedAnalysis: finalResult.degradedAnalysis ?? false,
    critiqued,
    critiqueAttempted,
    critiqueAttemptFailed,
    critiqueError,
    preCritiqueRecommendation: critiqued ? originalResult.recommendation : null,
    preCritiqueConfidence: critiqued ? originalResult.confidence : null,
    preCritiqueReasoning: critiqued ? originalResult.reasoning : null,
    critiqueNotes,
    outcome: null,
    settledAt: null,
    oddsAtPick: clvResult.odds,
    clvCaptured: clvResult.captured,
    clvCaptureSource: clvResult.source,
    closingOdds: null,
    clvDelta: null,
  };

  const pick = await prisma.pick.upsert({
    where: { eventId },
    update: { ...pickData, createdAt: new Date() },
    create: { eventId, ...pickData },
  });

  return pick;
}

function coerceMarket(market: string, marketMenu: MarketMenuItem[], sportKey: string): string {
  if (market !== NONE_MARKET && !marketMenu.some((m) => m.id === market)) {
    console.warn(`[analyzeEvent] model returned off-menu market "${market}" for sport "${sportKey}" — coercing to "none".`);
    return NONE_MARKET;
  }
  return market;
}

// League base rates — added 2026-08-01, computed entirely from
// MatchResult data this app already ingests (see leagueBaseRates.ts),
// recomputed once per results ingestion cycle. Genuinely absent (not
// just thin) for a league until this app has settled at least one result
// in it — stated explicitly rather than omitted, same "absence is a
// finding, not a gap to silently fill" ethos as the rest of this prompt.
async function buildLeagueContextBlock(sportId: number, leagueTitle: string): Promise<string> {
  const rate = await prisma.leagueBaseRate.findUnique({ where: { sportId } });
  if (!rate || rate.resultsSampleSize === 0 || rate.goalsPerMatch == null) {
    return `No league base-rate data yet for ${leagueTitle} — this app hasn't settled enough of its own results in this league to compute one. Interpret team-level numbers without this context for now.`;
  }

  const parts = [
    `${rate.goalsPerMatch.toFixed(2)} goals/match`,
    `home win ${Math.round((rate.homeWinPct ?? 0) * 100)}%`,
    `draw ${Math.round((rate.drawPct ?? 0) * 100)}%`,
    `away win ${Math.round((rate.awayWinPct ?? 0) * 100)}%`,
  ];
  if (rate.cornersPerMatch != null) parts.push(`${rate.cornersPerMatch.toFixed(1)} corners/match`);
  if (rate.cardsPerMatch != null) parts.push(`${rate.cardsPerMatch.toFixed(1)} cards/match`);

  const cornersCardsNote =
    rate.cornersCardsSampleSize < rate.resultsSampleSize
      ? ` (corners/cards figures from a smaller sample of ${rate.cornersCardsSampleSize} match${rate.cornersCardsSampleSize === 1 ? "" : "es"} — not every result source carries them)`
      : "";

  return `League context (${leagueTitle}, based on ${rate.resultsSampleSize} match${rate.resultsSampleSize === 1 ? "" : "es"} this app has settled so far${cornersCardsNote}): ${parts.join(", ")}.`;
}

// Feedback loop (added 2026-08-01): the model's own past picks are
// settled and graded (settlement.ts) and aggregated into a calibration
// report (calibration.ts), but until now that report was reporting-only —
// surfaced on the dashboard's Track Record panel for a HUMAN to read,
// never fed back into a new analysis. This closes that loop: a new pick
// now gets its own track record (overall, by confidence band, by market,
// by this specific league) as prompt context, gated by the exact same
// reliability threshold the calibration report itself uses (~30 graded
// picks) — a 4-pick sample saying "80% hit rate" would be actively
// misleading, not useful signal, so this suppresses itself rather than
// hand the model a number that isn't statistically meaningful yet.
async function buildPerformanceFeedbackBlock(leagueTitle: string): Promise<string> {
  const report = await computeCalibrationReport();
  const { overall, byConfidenceBand, byMarket, byLeague, minReliableSample } = report;

  if (!overall.reliable) {
    const graded = overall.wins + overall.losses;
    return `Not enough of your own settled picks yet (${graded} graded so far, need ~${minReliableSample}+) for a statistically meaningful track record. Proceed without this context — a small sample isn't a real accuracy signal, don't let it push your confidence up or down.`;
  }

  const lines: string[] = [
    `Overall: ${overall.wins + overall.losses} of your own past picks graded, ${Math.round(overall.hitRate! * 100)}% hit rate, Brier score ${overall.brierScore!.toFixed(3)} (0 = perfect, lower is better).`,
  ];

  const reliableBands = byConfidenceBand.filter((b) => b.reliable);
  if (reliableBands.length > 0) {
    lines.push(
      "By confidence band: " +
        reliableBands
          .map((b) => {
            const gapPp = Math.round(Math.abs(b.calibrationGap!) * 100);
            const direction = b.calibrationGap! < -0.02 ? `overconfident by ${gapPp}pp` : b.calibrationGap! > 0.02 ? `underconfident by ${gapPp}pp` : "well-calibrated";
            return `${b.band} (n=${b.count}): actual hit rate ${Math.round(b.hitRate! * 100)}% vs stated confidence ${Math.round(b.avgStatedConfidence! * 100)}% — ${direction}`;
          })
          .join("; ") + "."
    );
  }

  const leagueStat = byLeague.find((l) => l.key === leagueTitle && l.reliable);
  if (leagueStat) {
    lines.push(`In ${leagueTitle} specifically: ${leagueStat.count} of your graded picks, ${Math.round(leagueStat.hitRate! * 100)}% hit rate.`);
  }

  const reliableMarkets = byMarket.filter((m) => m.reliable);
  if (reliableMarkets.length > 0) {
    lines.push("By market type: " + reliableMarkets.map((m) => `${m.key} (n=${m.count}): ${Math.round(m.hitRate! * 100)}% hit rate`).join("; ") + ".");
  }

  return lines.join("\n");
}

const NEWS_POOL_SIZE = 40; // read this many recent league items before filtering, so team-specific ones further back still have a chance to surface
const NEWS_BLOCK_CAP = 8; // raised from 5 (2026-08-01) — now that filtering makes items more relevant, more of them fit before diminishing returns

// Team-relevance filtering (added 2026-08-01): news is ingested per-SPORT
// (see newsIngestion.ts — there's no team dimension at ingestion time), so
// without this a fixture's news block could be entirely about a different
// club in the same league. Team-specific items (mentions either side by
// name or a significant name token — see teamNameMatch.ts; this does NOT
// catch nicknames like "Gunners" for Arsenal, since this app has no
// nickname database and guessing one would risk fabricating matches) rank
// above general league items, which only fill remaining slots. Each item
// is labeled in the prompt so the model can weight a team-specific report
// above a generic league story about neither side.
async function buildNewsBlock(sportKey: string, homeTeam: string, awayTeam: string): Promise<string> {
  const pool = await prisma.newsItem.findMany({
    where: { sportKey },
    orderBy: { publishedAt: "desc" },
    take: NEWS_POOL_SIZE,
  });

  if (pool.length === 0) return "No recent news found.";

  const teamSpecific = pool.filter((n) => mentionsTeam(`${n.title} ${n.summary ?? ""}`, homeTeam) || mentionsTeam(`${n.title} ${n.summary ?? ""}`, awayTeam));
  const teamSpecificIds = new Set(teamSpecific.map((n) => n.id));
  const general = pool.filter((n) => !teamSpecificIds.has(n.id));

  const selected = [...teamSpecific, ...general].slice(0, NEWS_BLOCK_CAP);
  const teamSpecificSelectedIds = new Set(teamSpecific.slice(0, NEWS_BLOCK_CAP).map((n) => n.id));

  return selected
    .map((n) => {
      const label = teamSpecificSelectedIds.has(n.id) ? "[TEAM-SPECIFIC]" : "[LEAGUE GENERAL]";
      return `- ${label} "${n.title}" (${n.source}, ${n.publishedAt.toISOString().slice(0, 10)}): ${n.summary ?? "n/a"}`;
    })
    .join("\n");
}

async function buildStatsBlock(homeTeam: string, awayTeam: string, sportKey: string): Promise<string> {
  // Priority: skip api-football entirely when football-data.org covers
  // this league — its data is current, api-football's is a stale season.
  // api-football is only actually called as a fallback for leagues
  // football-data doesn't cover at all.
  const footballDataCoversThis = FOOTBALL_DATA_PROVIDER?.supportsSport?.(sportKey) ?? false;

  const sections = await Promise.all(
    statsProviders.map(async (provider) => {
      if (provider === API_FOOTBALL_PROVIDER && footballDataCoversThis) return null;

      // A provider with a STATIC per-sportKey coverage map (e.g.
      // ApiFootballStatsProvider, FootballDataStatsProvider) that doesn't
      // cover this sportKey at all is a known, permanent non-match — not
      // a failure worth counting toward its 3-strikes health tracking
      // (that miscount is exactly what disabled football-data after a
      // run of MLS-only fixtures it was never going to cover — see
      // dataSourceHealth investigation notes). Skip silently, no
      // shouldAttempt/recordAttempt call either way.
      if (provider.supportsSport && !provider.supportsSport(sportKey)) return null;

      if (!(await shouldAttempt(provider.name))) return null;

      const [home, away] = await Promise.all([
        fetchTeamStatsSafely(provider, homeTeam, sportKey),
        fetchTeamStatsSafely(provider, awayTeam, sportKey),
      ]);
      const lines = [home.line, away.line].filter((s): s is string => !!s);
      // quota_exhausted (added 2026-08-04): a provider's own request quota
      // hitting zero (SofaScore: 200/~31 days, the app's sole xG source)
      // is a fundamentally different situation from a genuine outage — see
      // dataSourceHealth.ts's recordAttempt comment. Either call erroring
      // with a quota signature is enough to tag the reason, even if the
      // other happened to succeed first.
      const quotaExhausted = home.quotaExhausted || away.quotaExhausted;
      await recordAttempt(provider.name, lines.length > 0, quotaExhausted ? "quota_exhausted" : undefined);
      if (lines.length === 0) return null;

      // Structural flag on top of api-football's own in-summary staleness
      // note (belt-and-braces — the model gets the caveat twice, once
      // here in the block header and once in the data itself).
      const header =
        provider === API_FOOTBALL_PROVIDER
          ? `${provider.name} stats [BACKGROUND CONTEXT ONLY — prior season, NOT current form; weight accordingly, only used because football-data.org has no coverage of this league]:`
          : `${provider.name} stats:`;
      return `${header}\n${lines.join("\n")}`;
    })
  );

  const usable = sections.filter((s): s is string => !!s);
  const combined = usable.length > 0 ? usable.join("\n\n") : "No corners/cards/form data available.";

  // xG availability check (added 2026-08-01, updated 2026-08-07): the
  // ONLY source in this app that ever supplies expected goals is now
  // AmericanSoccerAnalysisProvider — free, no quota, but MLS only (its
  // "xG X.XX-Y.YY" summary fragment; ESPN's box score has no xG field at
  // all, and fbref.com/Understat, the two usual free xG sources, are
  // blocked — see AmericanSoccerAnalysisProvider.ts's header for the full
  // search). SofaScoreRapidApiProvider (previously the sole xG source,
  // 200-requests/month quota) was disabled 2026-08-07 for realistically
  // never surviving this app's actual pick volume. This means xG is now
  // structurally unavailable for 23 of this app's 24 tracked leagues, not
  // just occasionally missing — the explicit gap-reporting below matters
  // more now than when this was written, not less: the analytical method
  // step 1 (form vs underlying performance) needs xG specifically and
  // should report the gap, not skip that reasoning step quietly or infer
  // a number that isn't there.
  const hasXg = /\bxG\b/.test(combined);
  return hasXg ? combined : `${combined}\n\nxG unavailable for this league/matchup — no source returned expected-goals data for either team this analysis. Do not infer over/underperformance vs underlying numbers without it; report this as a data gap instead.`;
}

interface StatsFetchResult {
  line: string | null;
  quotaExhausted: boolean;
}

async function fetchTeamStatsSafely(provider: StatsProvider, teamName: string, sportKey: string): Promise<StatsFetchResult> {
  try {
    const snapshot = await provider.fetchTeamStats(teamName, sportKey);
    return { line: snapshot ? `- ${snapshot.summary}` : null, quotaExhausted: false };
  } catch (err) {
    console.error(`[analyzeEvent] stats lookup failed for "${teamName}" via ${provider.name}:`, (err as Error).message);
    return { line: null, quotaExhausted: isQuotaExhaustedError(err) };
  }
}

// Generic across any provider fronted by a rate-limited API, not just
// SofaScore — a 429, or a response explicitly reporting zero requests
// remaining, means the request never had a chance to succeed or fail on
// its own merits, which is a different situation from the source itself
// being broken (see dataSourceHealth.ts's recordAttempt "reason" param).
function isQuotaExhaustedError(err: unknown): boolean {
  const response = (err as { response?: { status?: number; headers?: Record<string, string> } })?.response;
  if (!response) return false;
  if (response.status === 429) return true;
  const remaining = response.headers?.["x-ratelimit-requests-remaining"];
  return remaining === "0";
}

// Weather is prompt-time only, keyed off the HOME team's venue (see
// resolveHomeVenueCity) — no venue field exists on Event, so this derives
// one from ESPN schedule data rather than skipping weather entirely.
async function buildWeatherBlock(homeTeam: string, sportKey: string, commenceTime: Date): Promise<string | null> {
  if (!weatherProvider) return null;

  const ref = ESPN_LEAGUE_BY_SPORT_KEY[sportKey];
  if (!ref) return null;

  if (!(await shouldAttempt(weatherProvider.name))) return null;

  try {
    const city = await resolveHomeVenueCity(ref, homeTeam);
    if (!city) {
      await recordAttempt(weatherProvider.name, false);
      return null;
    }

    const forecast = await weatherProvider.fetchForecast(city, commenceTime);
    await recordAttempt(weatherProvider.name, !!forecast);
    return forecast ? forecast.summary : null;
  } catch (err) {
    console.error(`[analyzeEvent] weather lookup failed for "${homeTeam}" (${sportKey}):`, (err as Error).message);
    await recordAttempt(weatherProvider.name, false);
    return null;
  }
}

// Restructured 2026-08-01: web search is now PRIMARY, structured data is
// VERIFICATION — flipped from the prior version, where search was a
// gap-filler triggered only when structured data was thin. Unlike the
// prior restructure, this one is NOT under a verbatim constraint — the
// prose below is free to be reworded/reordered as needed, as long as it
// keeps: search-first framing with the 5 named search targets,
// structured data explicitly reframed as verification (not primary
// narrative), the AGREE/DISAGREE/only-one-had-it cross-checking
// requirement with its confidence implications, the "use the structured
// value but label it last-resort" fallback when search misses something,
// and the discrepancies field in the JSON output.
function buildEventAnalysisPrompt(ctx: {
  sport: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  currentDate: string;
  statsBlock: string;
  weatherBlock: string | null;
  leagueContextBlock: string;
  performanceFeedbackBlock: string;
  newsBlock: string;
  marketMenu: MarketMenuItem[];
}): string {
  const menuBlock = ctx.marketMenu.map((m) => `  - "${m.id}": ${m.description}`).join("\n");

  return `You are a professional football analyst producing advisory betting analysis. You are advisory only — the human decides and places any bet themselves.

Event: ${ctx.homeTeam} vs ${ctx.awayTeam} (${ctx.sport})
Kickoff: ${ctx.commenceTime}
Today's date: ${ctx.currentDate}

PRIMARY: WEB SEARCH

Web search is your PRIMARY information-gathering method for this analysis — start
here, not with the structured data further below. Before relying on anything else in
this prompt, search for:

1. Recent form (last 2-3 weeks) for both ${ctx.homeTeam} and ${ctx.awayTeam}.
2. Current injuries, suspensions, and lineup news for both sides.
3. Head-to-head history between these two teams.
4. Current odds/betting market prices for this fixture.
5. Where reportable, corners/cards tendencies for both teams.
6. The appointed referee for this match, and their cards-per-game average if reportable — referee identity is a real, material signal for cards markets specifically, but is genuinely unavailable from this app's structured data sources (verified 2026-08-02: neither ESPN's nor football-data.org's match APIs populate referee/officials data before kickoff, only after). Search is the only channel that can occasionally surface it, typically via a referee-appointment article close to kickoff — don't expect to find it for most fixtures.
   Investigated further 2026-08-03: worldfootball.net publishes exactly this data (per-referee matches/cards, current-season, confirmed live for 6 of this app's tracked leagues, including the specific referee flagged as a gap in a real pick) — but its robots.txt explicitly disallows ClaudeBot by name and declares ai-train=no. That's an express policy refusal, not a technical block, so no scraper was built against it (same "explicit disallow = hard no" rule this app already applies to news scraping — see ScraperNewsProvider.ts). FBref remains Cloudflare-blocked (re-verified). This confidence-cap fallback stays as the real mitigation until a licensed source appears.

Search each of these deliberately and specifically — don't rely on one broad query to
cover all five. For every search result you use: note its publication date and check
it is current relative to today's date above. A three-week-old injury report may be
obsolete. Prefer established football media over aggregators and forums. If sources
conflict with each other, say so and prefer the more recent and more reputable one
rather than picking the one that suits a cleaner conclusion.

VERIFICATION DATA

Everything below this point was collected from structured APIs (stats providers,
weather forecasts) specifically to CROSS-CHECK what your search above found — it is
not the primary narrative, and shouldn't be read as one. Where it adds detail your
search didn't surface, use it; where it overlaps with what you found, use it to
confirm or challenge your search findings.

Recent relevant news (structured feed — your search above should already have found
more current, team-specific coverage than this):
${ctx.newsBlock}

${ctx.leagueContextBlock}
Interpret every team-level number below relative to this league context, not in absolute terms — e.g. a team averaging 10 corners/match is unremarkable in a league that averages 10.2, but notable in one that averages 8.5.

Stats (structured, for cross-checking against what search found on form and corners/cards tendencies):
${ctx.statsBlock}

Note on corners/cards specifically: the figures above are per-team. To assess total_corners, over_under_corners, total_cards, and over_under_bookings, add both teams' corners (or cards/bookings) together to estimate the match total against the conventional thresholds (corners 8.5-11.5, cards 2.5-4.5) — consider these total-count markets as real candidates whenever both teams have usable corners/cards data, not only the team_corners/team_cards framing of which side wins the count. Where a "[split: home (n=..); away (n=..)]" tag shows an actual number (not a suppression note), prefer the split figure matching that team's role in THIS fixture (the home team's home split, the away team's away split) over the blended figure — a blended recent-form average can mask a real home/away-specific rate. A split below n=3 is suppressed at the source and shown as "split suppressed (insufficient sample: n=..)" instead of a number — a 1-2 match sample is one outlier wearing a statistic's clothing, not a real average, so fall back to the blended figure whenever you see that note or no split at all.

Kickoff weather forecast:
${ctx.weatherBlock ?? "No weather forecast available for this match."}

Note on odds/market pricing: this app has no structured odds feed as of 2026-08-03
(see fixtureIngestion.ts for why) — current odds/betting market prices come ENTIRELY
from your web search above (search target 4). Treat whatever you found there as a
single-sourced fact unless multiple independent search results agree with each other
on price/direction, same as any other search-only finding.

CROSS-CHECKING

For each material fact (form, injuries, head-to-head, corners/cards tendencies) that
BOTH your search and the structured verification data below could plausibly cover,
determine whether they AGREE, DISAGREE, or only one of them had it. Odds/market
pricing has no structured counterpart to cross-check against (search-only, as noted
above) — treat it under the single-source rule, not this cross-checking one:

- AGREEMENT between search and structured data is a real, independent confirmation —
  it should increase your confidence in that specific fact, and in any pick that
  rests on it.
- DISAGREEMENT must be flagged explicitly (see "discrepancies" in the output format
  below) — state which value you preferred and why (recency, source reliability).
  Never silently pick one value over the other without saying so.
- If your search did not find something the verification data has, use the
  verification value, but label it as a source of last resort in your reasoning —
  it wasn't independently confirmed by search, so it shouldn't carry the same weight
  as a fact both sources agree on.

ANALYTICAL METHOD

Work through these factors in order. For each, state what the data shows, or state
plainly that it is unavailable — never infer a value that isn't there.

1. Form and underlying performance — recent results, and where available whether
   results are outperforming or underperforming underlying numbers. A team winning
   on poor underlying performance is likely to regress, and vice versa.
2. Head-to-head and stylistic matchup — how these specific sides have played each
   other, and whether their styles interact in a way that raises or suppresses
   goals, corners, or cards.
3. Team news — injuries, suspensions, expected absences. Distinguish a squad player
   from a key player.
4. Situational context — fixture congestion, days of rest, travel, competition
   priority, and what each side needs from this match given league position.
5. Venue and conditions — home/away splits, and weather effects on likely game state.
6. Market pricing — what bookmakers imply, treated as an informed opinion to weigh,
   not a fact to defer to.

EVIDENCE STANDARD

Label every substantive claim as one of three types:

— SEARCH: a specific fact you retrieved via web search (your primary source for this
  analysis). Cite the outlet and the publication date.
— EVIDENCE: a specific fact from the structured verification data blocks above. Cite
  which source.
— PRINCIPLE: general football analysis not specific to these teams (congestion
  effects, home advantage, weather and set pieces). Legitimate reasoning, but it
  cannot by itself justify high confidence.

Do not state any specific claim about these teams' current form, roster, manager, or
injuries from your own training knowledge. Your training data may be months out of
date and these change constantly. If it is not in the data above and you did not
retrieve it via search, you do not know it. Absence of data is a finding to report,
not a gap to fill.

A numeric market price is not more reliable than qualitative evidence merely because
it is precise.

YOUR TRACK RECORD

${ctx.performanceFeedbackBlock}

Use this to calibrate, not to anchor: if a confidence band above has historically
run overconfident (actual hit rate below what you stated), be more conservative
landing in that range again today unless the evidence here is unusually strong. If a
market type or this league shows a materially different hit rate than your overall
average, let that inform — but not override — your read of the actual evidence in
front of you for this specific match.

SELECTION

Evaluate every market in the menu where the data gives genuine signal. Select the ONE
that stands out most clearly. Prefer markets where search and structured data
corroborate each other over those resting on a single source.

If nothing clears a reasonable bar, answer "none". A disciplined pass is a valid and
useful output, and is strongly preferred over a manufactured pick. You are not
required to find a bet.

Calibrate confidence honestly:
- 0.7+ requires multiple independent sources agreeing (search AND structured data,
  or multiple distinct search results), with no material contradicting signal.
- 0.4–0.7 means a real but single-sourced or partially contradicted lean.
- Below 0.4 should generally be "none" instead.
If key data was missing, a search failed to resolve a material gap, or a discrepancy
between search and structured data couldn't be confidently resolved, cap confidence
accordingly and say so explicitly. For total_cards, over_under_bookings, and
team_cards specifically: if you could not find the appointed referee (the normal
case), cap confidence at 0.6 even if team-level card averages otherwise look
decisive — those averages reflect the TEAMS' typical discipline, not this specific
referee's, and referee identity is known to swing card counts materially on its own.

Markets:
${menuBlock}
  - "none": nothing in the available data gives you a confident view on any of the above.

Respond with ONLY this JSON:
{
  "market": "...",
  "recommendation": "...",
  "confidence": 0.0,
  "reasoning": "...",
  "keyFactors": ["..."],
  "dataGaps": ["..."],
  "dataAvailability": {"xg": "available|unavailable|partial", "corners": "available|unavailable|partial", "cards": "available|unavailable|partial", "lineups": "available|unavailable|partial", "injuries": "available|unavailable|partial", "weather": "available|unavailable|partial", "referee": "available|unavailable|partial", "h2h": "available|unavailable|partial", "oddsFeed": "available|unavailable|partial"},
  "searchesPerformed": ["query — what it resolved"],
  "runnerUp": {"market": "...", "whyWeaker": "..."},
  "discrepancies": [{"fact": "...", "searchValue": "...", "apiValue": "...", "resolution": "..."}]
}

In "reasoning" (4–8 sentences): cite specific data from at least two different source
types, label each claim EVIDENCE / SEARCH / PRINCIPLE, and state what would change
your mind. In "dataAvailability": mark EVERY one of the 9 listed categories exactly
"available" (you had solid, usable data for it), "partial" (something, but thin,
stale, or unconfirmed), or "unavailable" (nothing usable) — a factual checklist of
what you actually had, every category, every time, not a summary of your reasoning.
In "dataGaps": list only gaps OUTSIDE those 9 categories (a specific unresolved
ambiguity, a conflicting report) — don't restate a category you've already marked in
dataAvailability. In "discrepancies": one entry per material fact where search and
structured data disagreed, with which value you preferred and why — empty array if
everything agreed or was single-sourced.`;
}
