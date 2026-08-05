/**
 * One-off backfill: settles any existing Picks whose results are
 * retrievable now. Just runResultsIngestionCycle with a wider window than
 * the daily job uses (30 days vs. 3) — the query itself (events with a
 * missing/incomplete MatchResult) already covers "existing picks", this
 * only widens how far back it's willing to look.
 *
 * The Odds API fallback still won't reach past 3 days (the API's own
 * daysFrom max — see TheOddsApiProvider.fetchScores), so anything older
 * than that relies entirely on ESPN resolving successfully; events ESPN
 * can't resolve (team-name mismatch, or genuinely too old for its
 * schedule endpoint) stay unresolved after this runs, not an error.
 *
 * Run with: npx tsx src/db/backfillResults.ts
 */
import "dotenv/config";
import { runResultsIngestionCycle } from "../lib/resultsIngestion";
import { prisma } from "./client";

const BACKFILL_DAYS_BACK = 30;

async function main() {
  console.log(`[backfillResults] scanning up to ${BACKFILL_DAYS_BACK} days back...`);
  const { resultsFetched, picksSettled } = await runResultsIngestionCycle(BACKFILL_DAYS_BACK);
  console.log(`[backfillResults] done: ${resultsFetched} results fetched, ${picksSettled} picks settled.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
