import { OddsProvider } from "./OddsProvider";
import { TheOddsApiProvider } from "./TheOddsApiProvider";

/**
 * Reads ODDS_PROVIDER from env and returns the matching implementation, or
 * null if unconfigured/no key (no mock fallback — see oddsIngestion.ts for
 * how a null provider is handled: ingestion is simply skipped, not faked).
 * Note this is no longer just an "enrichment" toggle — since the pivot to
 * The Odds API as the primary fixture+odds source, a null provider here
 * means NO fixtures get ingested at all, not just "odds go missing."
 */
export function getOddsProvider(): OddsProvider | null {
  const which = (process.env.ODDS_PROVIDER || "").toLowerCase();

  if (which !== "the-odds-api") {
    return null;
  }
  if (!process.env.THE_ODDS_API_KEY) {
    console.warn("[odds] ODDS_PROVIDER=the-odds-api but THE_ODDS_API_KEY is not set — odds disabled.");
    return null;
  }
  return new TheOddsApiProvider(process.env.THE_ODDS_API_KEY, process.env.ODDS_REGIONS || "uk");
}

export * from "./OddsProvider";
