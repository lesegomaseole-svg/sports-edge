import { StatsProvider } from "./StatsProvider";
import { EspnMatchStatsProvider } from "./EspnMatchStatsProvider";
import { SportMonksStatsProvider } from "./SportMonksStatsProvider";
import { FootballDataStatsProvider } from "./FootballDataStatsProvider";
import { FootballDataCoUkProvider } from "./FootballDataCoUkProvider";
import { AmericanSoccerAnalysisProvider } from "./AmericanSoccerAnalysisProvider";
import { DATA_SOURCES } from "../../config/dataSources";

function instantiate(sourceId: string): StatsProvider | null {
  switch (sourceId) {
    case "espn-match-stats":
      return new EspnMatchStatsProvider();
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
    case "football-data-co-uk":
      return new FootballDataCoUkProvider(); // no key required
    case "american-soccer-analysis":
      return new AmericanSoccerAnalysisProvider(); // no key required
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
 * enabled stats source EXCEPT the quota- or plan-constrained ones
 * (SPORTMONKS_API_KEY, FOOTBALL_DATA_API_KEY). Those are deliberately
 * prompt-time-only (see each provider's file header): oddsIngestion.ts's
 * loop runs across every tracked league on every cycle, which would burn
 * through a tight quota almost immediately, whereas analyzeEvent.ts is
 * called at most once per "Analyse" click. usedForIngestionScoring on the
 * DATA_SOURCES entry is the flag controlling this split — defaults to true
 * (EspnMatchStatsProvider's current, cheap, always-on behavior) unless
 * explicitly opted out.
 */
export function getIngestionScoringStatsProviders(): StatsProvider[] {
  const enabled = DATA_SOURCES.filter((s) => s.category === "stats" && s.enabled && s.usedForIngestionScoring !== false);
  return enabled.map((s) => instantiate(s.id)).filter((p): p is StatsProvider => p !== null);
}

export * from "./StatsProvider";
