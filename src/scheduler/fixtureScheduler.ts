/**
 * Polling scheduler for the primary ingestion cycle — fixtures from ESPN
 * (see fixtureIngestion.ts). Renamed from oddsScheduler.ts (2026-08-03)
 * alongside the fixture/odds decoupling — see fixtureIngestion.ts's file
 * header for the full reasoning. No provider-configured guard anymore:
 * EspnFixtureProvider needs no key/config, so unlike the old
 * getOddsProvider()-gated version, this always runs.
 *
 * Daily by default, which fits the "today only" fixture window: the cron
 * pattern below fires once at midnight (UTC) — right as "today" rolls
 * over — to pick up the new day's full fixture set, plus once immediately
 * on startup via the tick() call below so the dashboard has data right
 * away regardless of when the server was last restarted. Interval is
 * env-driven (FIXTURE_POLL_INTERVAL_HOURS) so it can be tightened later
 * if needed.
 */
import cron from "node-cron";
import { runFixtureIngestionCycle } from "../lib/fixtureIngestion";

let running = false;

export function startFixtureScheduler() {
  const hours = Number(process.env.FIXTURE_POLL_INTERVAL_HOURS || 24);
  console.log(`[fixtureScheduler] polling every ${hours}h`);
  cron.schedule(`0 */${hours} * * *`, () => void tick());

  void tick(); // run once immediately on startup so the dashboard has data right away
}

async function tick() {
  if (running) return; // avoid overlapping cycles if a fetch is slow
  running = true;
  try {
    const { ingested, rejectedInsufficientData } = await runFixtureIngestionCycle();
    console.log(`[fixtureScheduler] cycle complete: ${ingested} ingested, ${rejectedInsufficientData} rejected (insufficient data)`);
  } catch (err) {
    console.error("[fixtureScheduler] cycle failed:", err);
  } finally {
    running = false;
  }
}
