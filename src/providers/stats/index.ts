import { StatsProvider } from "./StatsProvider";
import { EspnMatchStatsProvider } from "./EspnMatchStatsProvider";
import { ApiFootballStatsProvider } from "./ApiFootballStatsProvider";
import { SportMonksStatsProvider } from "./SportMonksStatsProvider";
import { FootballDataStatsProvider } from "./FootballDataStatsProvider";
import { SofaScoreRapidApiProvider } from "./SofaScoreRapidApiProvider";
import { DATA_SOURCES } from "../../config/dataSources";

function instantiate(sourceId: string): StatsProvider | null {
  switch (sourceId) {
    case "espn-match-stats":
      return new EspnMatchStatsProvider();
    case "api-football": {
      const apiKey = process.env.API_FOOTBALL_KEY;
      if (!apiKey) {
        console.warn("[stats] 'api-football' is enabled in dataSources.ts but API_FOOTBALL_KEY is not set — skipping.");
        return null;
      }
      return new ApiFootballStatsProvider(apiKey);
    }
    case "sportmonks": {
      const apiKey = process.env.SPORTMONKS_API_KEY;
      if (!apiKey) {
        console.warn("[stats] 'sportmonks' is enabled in dataSources.ts but SPORTMONKS_API_KEY is not set — skipping.");
        return null;
      }
      return new SportMonksStatsProvider(apiKey);
    }
    case "football-data": {
      const apiKey = process.env.FOOTBALL_DATA_API_KEY;
      if (!apiKey) {
        console.warn("[stats] 'football-data' is enabled in dataSources.ts but FOOTBALL_DATA_API_KEY is not set — skipping.");
        return null;
      }
      return new FootballDataStatsProvider(apiKey);
    }
    case "sofascore": {
      const apiKey = process.env.SOFASCORE_RAPIDAPI_KEY;
      if (!apiKey) {
        console.warn("[stats] 'sofascore' is enabled in dataSources.ts but SOFASCORE_RAPIDAPI_KEY is not set — skipping.");
        return null;
      }
      return new SofaScoreRapidApiProvider(apiKey);
    }
    default:
      console.warn(`[stats] unknown enabled data source id "${sourceId}" — no provider wired for it.`);
      return null;
  }
}

/**
 * Returns every enabled stats source (per src/config/dataSources.ts),
 * instantiated and ready to query — used by analyzeEvent.ts, which merges
 * all of them into the prompt's stats block for both teams.
 */
export function getEnabledStatsProviders(): StatsProvider[] {
  const enabled = DATA_SOURCES.filter((s) => s.category === "stats" && s.enabled);
  return enabled.map((s) => instantiate(s.id)).filter((p): p is StatsProvider => p !== null);
}

/**
 * Subset of getEnabledStatsProviders() actually safe to call once per new
 * fixture during oddsIngestion.ts's data-sufficiency scoring — i.e. every
 * enabled stats source EXCEPT the three quota-constrained ones added
 * alongside API_FOOTBALL_KEY/SPORTMONKS_API_KEY/FOOTBALL_DATA_API_KEY.
 * Those three are deliberately prompt-time-only (see each provider's file
 * header): oddsIngestion.ts's loop runs across every tracked league on
 * every cycle, which would burn through e.g. API-Football's 100/day quota
 * almost immediately, whereas analyzeEvent.ts is called at most once per
 * "Analyse" click. usedForIngestionScoring on the DATA_SOURCES entry is
 * the flag controlling this split — defaults to true (EspnMatchStatsProvider's
 * current, cheap, always-on behavior) unless explicitly opted out.
 */
export function getIngestionScoringStatsProviders(): StatsProvider[] {
  const enabled = DATA_SOURCES.filter((s) => s.category === "stats" && s.enabled && s.usedForIngestionScoring !== false);
  return enabled.map((s) => instantiate(s.id)).filter((p): p is StatsProvider => p !== null);
}

export * from "./StatsProvider";
