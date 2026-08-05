import cron from "node-cron";
import { runResultsIngestionCycle } from "../lib/resultsIngestion";
import { recomputeLeagueBaseRates } from "../lib/leagueBaseRates";

// Daily, free (ESPN, keyless) with a quota-aware fallback (The Odds
// API's /scores — see resultsIngestion.ts) — matches oddsScheduler.ts's
// own "once a day is enough" reasoning, and results genuinely don't
// change once a match is final, so there's no benefit to polling faster.
const RESULTS_POLL_INTERVAL_HOURS = Number(process.env.RESULTS_POLL_INTERVAL_HOURS || 24);

export function startResultsScheduler() {
  console.log(`[resultsScheduler] polling every ${RESULTS_POLL_INTERVAL_HOURS}h`);
  cron.schedule(`0 */${RESULTS_POLL_INTERVAL_HOURS} * * *`, () => void tick());
  void tick(); // run once immediately so recent results settle right away on startup
}

async function tick() {
  try {
    const { resultsFetched, picksSettled } = await runResultsIngestionCycle();
    console.log(`[resultsScheduler] cycle complete: ${resultsFetched} results fetched, ${picksSettled} picks settled`);

    // Recompute league base rates after every cycle — cheap (in-process
    // aggregation over already-fetched MatchResult rows, no network
    // calls) and keeps them current with whatever results just landed.
    const { leaguesUpdated } = await recomputeLeagueBaseRates();
    console.log(`[resultsScheduler] base rates recomputed for ${leaguesUpdated} league(s)`);
  } catch (err) {
    console.error("[resultsScheduler] cycle failed:", err);
  }
}
