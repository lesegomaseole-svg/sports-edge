/**
 * Closing-odds capture scheduler (added 2026-08-03) — see clv.ts for the
 * full reasoning. Runs every 30 minutes by default (down from 15 —
 * revisited 2026-08-05 as part of Oracle deployment prep, see K2 in that
 * thread) because the "shortly before kickoff" capture window is narrow
 * (2h before to 30min after kickoff = 2.5h total, see CLOSING_WINDOW_* in
 * clv.ts) and fixtures kick off at all hours.
 *
 * The 2.5h window is a hard ceiling on how coarse this can safely go: a
 * fixed-interval cron only reliably lands inside every possible window
 * position if the interval is meaningfully shorter than the window itself
 * — at 30min that's ~5 ticks per window (safe margin against any single
 * missed/failed tick); an interval of "a few hours" would routinely be
 * LONGER than the window, meaning some picks' closing lines would never
 * get checked at all, not just checked late. Loosening this further would
 * mean widening CLOSING_WINDOW_* instead (capturing further from kickoff),
 * which changes what "closing line" means for the CLV metric itself —
 * that's a measurement-definition change, not a polling-cost one, so it
 * isn't done here.
 *
 * Cheap to run often regardless of interval: it's a single DB query for
 * candidates first, and a live odds fetch only happens for picks actually
 * in-window — most ticks find nothing and make zero network calls. The
 * real cost driver this interval change targets is retries: a pick whose
 * fetch fails (no quote found yet) stays eligible and gets re-attempted on
 * every tick until it succeeds or its window closes — halving the tick
 * rate roughly halves worst-case retry volume for exactly the thin-market
 * fixtures (see K4) most likely to have a slow/missing quote.
 */
import cron from "node-cron";
import { runClosingOddsCapture } from "../lib/clv";

let running = false;

export function startClvScheduler() {
  const minutes = Number(process.env.CLV_POLL_INTERVAL_MINUTES || 30);
  console.log(`[clvScheduler] polling every ${minutes}min`);
  cron.schedule(`*/${minutes} * * * *`, () => void tick());
  // Catch-up run on boot (added 2026-08-05) — without this, a pick sitting
  // in its closing window at the moment of a restart/deploy waits up to a
  // full interval for its first check, same reliability gap fixtureScheduler
  // and resultsScheduler already close with their own startup tick().
  void tick();
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const { checked, captured } = await runClosingOddsCapture();
    if (checked > 0) {
      console.log(`[clvScheduler] cycle complete: ${checked} in closing window, ${captured} closing prices captured`);
    }
  } catch (err) {
    console.error("[clvScheduler] cycle failed:", err);
  } finally {
    running = false;
  }
}
