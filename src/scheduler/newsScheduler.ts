import cron from "node-cron";
import { runNewsIngestionCycle } from "../lib/newsIngestion";

export function startNewsScheduler() {
  const minutes = Number(process.env.NEWS_POLL_INTERVAL_MINUTES || 15);
  console.log(`[newsScheduler] polling every ${minutes}m`);

  cron.schedule(`*/${minutes} * * * *`, () => void tick());
  void tick(); // run once immediately
}

async function tick() {
  try {
    const { items } = await runNewsIngestionCycle();
    console.log(`[newsScheduler] cycle complete: ${items} new items`);
  } catch (err) {
    console.error("[newsScheduler] cycle failed:", err);
  }
}
