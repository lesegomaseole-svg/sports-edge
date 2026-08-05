import { NewsProvider } from "./NewsProvider";
import { NewsApiProvider } from "./NewsApiProvider";
import { NewsDataIoProvider } from "./NewsDataIoProvider";
import { RssNewsProvider } from "./RssNewsProvider";
import { ScraperNewsProvider } from "./ScraperNewsProvider";
import { DATA_SOURCES } from "../../config/dataSources";

// Verified live (HTTP 200, non-empty <item> list) 2026-07-30. Simplified to
// one general BBC Sport football feed — the app is soccer-only now, and
// this covers all tracked leagues (20 as of 2026-08-01) instead of
// needing a per-league feed.
const BBC_SPORT_FOOTBALL_FEED = ["https://feeds.bbci.co.uk/sport/football/rss.xml"];

/**
 * Returns every enabled news source (per src/config/dataSources.ts),
 * instantiated and ready to query. Multiple sources can be enabled at
 * once — they all feed the same pool (see runNewsIngestionCycle, which
 * merges + de-dupes across all of them). No mock fallback: if nothing
 * ends up enabled/usable, this returns an empty array and news ingestion
 * cycles simply produce 0 items rather than fake ones.
 */
export function getEnabledNewsProviders(): NewsProvider[] {
  const enabled = DATA_SOURCES.filter((s) => s.category === "news" && s.enabled);
  const providers: NewsProvider[] = [];

  for (const source of enabled) {
    switch (source.id) {
      case "newsdata-io": {
        const apiKey = process.env.NEWSDATA_API_KEY;
        if (!apiKey) {
          console.warn("[news] 'newsdata-io' is enabled in dataSources.ts but NEWSDATA_API_KEY is not set — skipping.");
          break;
        }
        providers.push(new NewsDataIoProvider(apiKey));
        break;
      }
      case "newsapi": {
        const apiKey = process.env.NEWSAPI_KEY;
        if (!apiKey) {
          console.warn("[news] 'newsapi' is enabled in dataSources.ts but NEWSAPI_KEY is not set — skipping.");
          break;
        }
        providers.push(new NewsApiProvider(apiKey));
        break;
      }
      case "bbc-sport-rss":
        providers.push(new RssNewsProvider(BBC_SPORT_FOOTBALL_FEED));
        break;
      case "generic-scraper":
        // Template only — see ScraperNewsProvider for the robots.txt/ToS
        // notes. Point this at a real base URL + selectors before use.
        providers.push(new ScraperNewsProvider("", { item: "", headline: "", link: "" }));
        break;
      default:
        console.warn(`[news] unknown enabled data source id "${source.id}" — no provider wired for it.`);
    }
  }

  return providers;
}

export * from "./NewsProvider";
