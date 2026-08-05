/**
 * Closing line value (CLV) — added 2026-08-03. The standard professional
 * proxy for genuine edge: win rate needs hundreds of picks to separate
 * skill from variance, but if the market consistently moves toward a
 * pick's side after it's made, that's a much lower-noise signal the read
 * was ahead of the market, measurable on a far smaller sample.
 *
 * Deliberately NOT built on the old OddsSnapshot table's continuous
 * polling — that ingestion path was removed the same day this was built,
 * when fixture discovery moved to ESPN and odds moved to the model's own
 * web search (see fixtureIngestion.ts's file header: The Odds API is
 * blocked at the network level on this dev machine). CLV only needs TWO
 * numbers per pick — the price when the pick was made, and the price
 * right before kickoff — so this does two live, on-demand odds checks
 * instead of depending on a table nothing writes to anymore.
 *
 * Coverage is real and partial, not approximated: only `match_winner`
 * picks map onto a directly-quoted h2h outcome. draw_no_bet/double_chance
 * are derived/combined markets with no direct quote, and every corners/
 * cards/goals-total market has no odds coverage from The Odds API at all
 * (h2h-only, per this app's scope — see analyzeEvent.ts). Both capture
 * functions return clvCaptured:false rather than guess when a pick's
 * market genuinely isn't coverable, or when a live fetch simply fails
 * (network block, no matching event found, no bookmakers quoting yet).
 */
import { prisma } from "../db/client";
import { getOddsProvider } from "../providers/odds";
import { NormalizedEvent } from "../providers/odds/OddsProvider";
import { mentionsTeam } from "./teamNameMatch";

const MATCH_TIME_TOLERANCE_MS = 6 * 60 * 60 * 1000; // 6h — generous enough for odds-API vs ESPN kickoff-time discrepancies, tight enough to avoid matching the wrong fixture between the same two teams on a different date

export interface CaptureResult {
  odds: number | null;
  captured: boolean;
  // Always "live" from this function — captureOddsAtPick only ever runs
  // from analyzeEvent.ts during real pick generation. A separate backfill
  // script (not this file — see the 2026-08-03 audit) sets "backfill"
  // directly when populating CLV fields from historical data after the
  // fact. Kept on this type so both paths are forced to be explicit about
  // which one they are, rather than a caller defaulting to an assumption.
  source: "live" | null;
}

/** True only for the one market type this app can map onto a directly-quoted h2h outcome — see file header. */
export function isClvCoverable(marketType: string): boolean {
  return marketType === "match_winner";
}

/**
 * Determines which h2h outcome name (a team name, or "Draw") a
 * match_winner recommendation refers to, from its free-text form (e.g.
 * "Boca Juniors to win" or "Draw" — see SOCCER_MARKET_MENU in
 * analyzeEvent.ts for the exact phrasing the model is asked to use).
 * Returns null if the recommendation text doesn't clearly name one side —
 * a genuinely malformed/unparseable recommendation should mean "can't
 * capture CLV for this", not a wrong guess.
 */
function extractH2hSide(recommendation: string, homeTeam: string, awayTeam: string): string | null {
  const text = recommendation.trim();
  if (/^draw$/i.test(text)) return "Draw";
  if (mentionsTeam(text, homeTeam)) return homeTeam;
  if (mentionsTeam(text, awayTeam)) return awayTeam;
  return null;
}

/**
 * Live odds lookup for one specific fixture — NOT the old ingestion-cycle
 * "fetch every tracked league" pattern, this is a single narrow fetch
 * scoped to one sport, matched down to one fixture by team name (fuzzy,
 * via mentionsTeam — the odds vendor's own team naming can differ
 * slightly from ESPN's, e.g. accents) + commence-time proximity. Returns
 * null if the fetch fails, the fixture isn't found in the response, or no
 * bookmaker is quoting h2h for it yet.
 */
async function fetchConsensusForSide(
  sportKey: string,
  homeTeam: string,
  awayTeam: string,
  commenceTime: Date,
  side: string
): Promise<number | null> {
  const provider = getOddsProvider();
  if (!provider) return null;

  let events: NormalizedEvent[];
  try {
    events = await provider.fetchOdds(sportKey, ["h2h"]);
  } catch {
    return null;
  }

  const match = events.find((ev) => {
    const sameTeams = mentionsTeam(ev.homeTeam, homeTeam) && mentionsTeam(ev.awayTeam, awayTeam);
    if (!sameTeams) return false;
    const gapMs = Math.abs(new Date(ev.commenceTime).getTime() - commenceTime.getTime());
    return gapMs <= MATCH_TIME_TOLERANCE_MS;
  });
  if (!match) return null;

  const prices: number[] = [];
  for (const market of match.markets) {
    if (market.marketType !== "h2h") continue;
    const outcome = market.outcomes.find((o) => o.name === side || mentionsTeam(side, o.name) || mentionsTeam(o.name, side));
    if (outcome && outcome.price > 0) prices.push(1 / outcome.price);
  }
  if (prices.length === 0) return null;

  // Consensus = simple mean of each quoting bookmaker's implied
  // probability, same approach the old (removed) buildOddsBlock used —
  // not de-vigged (overround left in) since this only needs to be
  // internally consistent between oddsAtPick and closingOdds, not an
  // absolute probability.
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

/**
 * Called from analyzeEvent.ts right after a pick is saved. Best-effort
 * and non-blocking in intent — a failed capture never fails the pick
 * itself, it just leaves clvCaptured false.
 */
export async function captureOddsAtPick(
  sportKey: string,
  marketType: string,
  recommendation: string,
  homeTeam: string,
  awayTeam: string,
  commenceTime: Date
): Promise<CaptureResult> {
  if (!isClvCoverable(marketType)) return { odds: null, captured: false, source: null };

  const side = extractH2hSide(recommendation, homeTeam, awayTeam);
  if (!side) return { odds: null, captured: false, source: null };

  const odds = await fetchConsensusForSide(sportKey, homeTeam, awayTeam, commenceTime, side);
  return { odds, captured: odds != null, source: odds != null ? "live" : null };
}

/**
 * Closing-capture pass (see clvScheduler.ts) — for every pick that
 * captured an opening price but hasn't captured a closing one yet, and
 * whose fixture's kickoff is close enough to be a meaningful "closing"
 * read (see CLOSING_WINDOW below), does one more live fetch and computes
 * clvDelta. Picks whose kickoff has passed beyond the grace window
 * without a successful capture are left alone permanently — the closing
 * line, by definition, stops existing once the match starts, so there's
 * no later moment where a real one becomes available.
 */
const CLOSING_WINDOW_BEFORE_MS = 2 * 60 * 60 * 1000; // capture starts up to 2h before kickoff
const CLOSING_WINDOW_AFTER_MS = 30 * 60 * 1000; // grace period in case the scheduler's own interval means it's checked slightly after kickoff

export async function runClosingOddsCapture(): Promise<{ checked: number; captured: number }> {
  const now = Date.now();

  const candidates = await prisma.pick.findMany({
    where: { clvCaptured: true, closingOdds: null },
    include: { event: { include: { sport: true } } },
  });

  let checked = 0;
  let captured = 0;

  for (const pick of candidates) {
    const kickoffMs = pick.event.commenceTime.getTime();
    const withinWindow = now >= kickoffMs - CLOSING_WINDOW_BEFORE_MS && now <= kickoffMs + CLOSING_WINDOW_AFTER_MS;
    if (!withinWindow) continue;

    checked++;
    const side = extractH2hSide(pick.recommendation, pick.event.homeTeam, pick.event.awayTeam);
    if (!side) continue; // shouldn't happen (clvCaptured=true implies this resolved before), defensive only

    const closingOdds = await fetchConsensusForSide(
      pick.event.sport.key,
      pick.event.homeTeam,
      pick.event.awayTeam,
      pick.event.commenceTime,
      side
    );
    if (closingOdds == null) continue;

    const clvDelta = pick.oddsAtPick != null ? closingOdds - pick.oddsAtPick : null;
    await prisma.pick.update({ where: { id: pick.id }, data: { closingOdds, clvDelta } });
    captured++;
  }

  return { checked, captured };
}

export interface ClvGroupStat {
  key: string;
  count: number; // picks WITH a computed clvDelta in this group
  positiveClvPct: number; // 0-1, share with clvDelta > 0
  avgClvDelta: number;
}

export interface ClvSourceReport {
  overall: ClvGroupStat | null; // null if this source's closingCaptured is 0 — nothing to report yet, not a fabricated 0%
  byMarket: ClvGroupStat[];
  byModelProvider: ClvGroupStat[];
}

export interface ClvReport {
  coverage: {
    totalPicks: number; // every pick ever generated
    coverableMarketPicks: number; // marketType this app can map to h2h (match_winner only, see isClvCoverable)
    oddsAtPickCaptured: number; // clvCaptured:true — coverable AND a live quote existed at analysis time
    closingCaptured: number; // clvDelta is non-null — the full pair captured, live + backfill combined (count only, never the stats)
  };
  // Added 2026-08-04: live and backfill are reported as fully separate
  // trees, never merged into one "overall" — see Pick.clvCaptureSource's
  // schema comment for why (pick 103's backfilled CLV was briefly
  // indistinguishable from a real production capture until this existed).
  // A caller that wants "the real number" wants `live`, always — backfill
  // exists to prove the computation logic against historical data, not to
  // report portfolio performance.
  live: ClvSourceReport;
  backfill: ClvSourceReport;
}

// Explicit framing per the task spec: CLV is only ever computed over the
// subset of picks with a real closing price captured — never silently
// presented as if it covered the whole portfolio. The `coverage` block
// above is what makes that honest: every consumer (the endpoint's own
// JSON shape, the dashboard) can see exactly how many of ALL picks this
// report actually speaks to.
export async function computeClvReport(): Promise<ClvReport> {
  const totalPicks = await prisma.pick.count();
  const coverableMarketPicks = await prisma.pick.count({ where: { marketType: "match_winner" } });
  const oddsAtPickCaptured = await prisma.pick.count({ where: { clvCaptured: true } });

  const withClv = await prisma.pick.findMany({
    where: { clvDelta: { not: null } },
    select: { marketType: true, modelProvider: true, clvDelta: true, clvCaptureSource: true },
  });

  const groupStat = (rows: typeof withClv): ClvGroupStat => {
    const deltas = rows.map((r) => r.clvDelta as number);
    const positive = deltas.filter((d) => d > 0).length;
    return {
      key: "",
      count: rows.length,
      positiveClvPct: positive / rows.length,
      avgClvDelta: deltas.reduce((a, b) => a + b, 0) / rows.length,
    };
  };

  const byKey = <T extends string>(rows: typeof withClv, keyFn: (r: (typeof withClv)[number]) => T): ClvGroupStat[] => {
    const groups = new Map<string, typeof withClv>();
    for (const r of rows) {
      const k = keyFn(r);
      const arr = groups.get(k) ?? [];
      arr.push(r);
      groups.set(k, arr);
    }
    return [...groups.entries()].map(([key, rows]) => ({ ...groupStat(rows), key }));
  };

  const reportFor = (source: "live" | "backfill"): ClvSourceReport => {
    const rows = withClv.filter((r) => r.clvCaptureSource === source);
    return {
      overall: rows.length > 0 ? { ...groupStat(rows), key: "overall" } : null,
      byMarket: byKey(rows, (r) => r.marketType),
      byModelProvider: byKey(rows, (r) => r.modelProvider),
    };
  };

  return {
    coverage: {
      totalPicks,
      coverableMarketPicks,
      oddsAtPickCaptured,
      closingCaptured: withClv.length,
    },
    live: reportFor("live"),
    backfill: reportFor("backfill"),
  };
}
