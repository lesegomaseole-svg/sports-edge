/**
 * Central, code-level registry of every data source in the system — odds,
 * news, stats, sentiment. This is the one place to add a new source or
 * flip one on/off; providers read this instead of scattering enable/disable
 * logic across env vars (env vars still hold credentials, e.g. THE_ODDS_API_KEY,
 * but *which sources are active* lives here).
 *
 * Preference order, most to least preferred: api > rss > scraper.
 *   - api     — licensed/official, stable shape, sanctioned usage.
 *   - rss     — public, low-maintenance, no ToS ambiguity.
 *   - scraper — brittle (breaks on markup changes) and carries ToS/legal
 *               risk. Fallback-only: use it when a source has no api or
 *               rss option, and only after checking that site's
 *               robots.txt and terms of service.
 *
 * No mock sources: every entry here is either a real source or absent.
 * When a source isn't configured/usable, the affected subsystem returns
 * empty results (and logs why) rather than fabricating data.
 *
 * Reliability tracking: the-odds-api, bbc-sport-rss, and espn-match-stats
 * are also tracked in the DataSourceHealth table (src/lib/dataSourceHealth.ts)
 * — 3 consecutive failures/empty ingestion cycles auto-disables a source
 * (retried once every 24h) independent of the `enabled` flag here, which
 * is the manual on/off switch. See GET /api/data-sources/health.
 */

export type DataSourceCategory = "fixtures" | "odds" | "news" | "stats" | "sentiment" | "weather";
export type DataSourceType = "api" | "rss" | "scraper";

export interface DataSourceConfig {
  id: string;
  category: DataSourceCategory;
  type: DataSourceType;
  enabled: boolean;
  description: string;
  // stats sources only. Defaults to true (checked-in behavior for
  // espn-match-stats). Set false for a source too quota-constrained to
  // call once per new fixture during fixtureIngestion.ts's sufficiency
  // scoring — see getIngestionScoringStatsProviders() in
  // src/providers/stats/index.ts. Such a source still runs normally at
  // prompt-time (analyzeEvent.ts, via getEnabledStatsProviders()).
  usedForIngestionScoring?: boolean;
}

export const DATA_SOURCES: DataSourceConfig[] = [
  // --- Fixtures ---
  // Added 2026-08-03: fixture discovery used to be fully coupled to
  // the-odds-api (below) — one call returned events AND odds together —
  // until that domain got blocked at the network level on the dev machine
  // (Zscaler content-category filter, confirmed live, not a quota/key
  // issue). Since a blocked odds vendor meant zero new fixtures at all,
  // fixture discovery moved to its own source. See
  // src/lib/fixtureIngestion.ts for the full reasoning.
  {
    id: "espn-fixtures",
    category: "fixtures",
    type: "api",
    enabled: true,
    description:
      "ESPN's public (undocumented, no-key) scoreboard endpoints — same infrastructure already proven reachable for results/stats/referee lookups elsewhere in this app. Bounded to TODAY ONLY via a single dates=YYYYMMDD scoreboard call per league. See src/providers/fixtures/EspnFixtureProvider.ts.",
  },

  // --- Odds ---
  // Odds is API-only, deliberately: no scraper option exists here, and one
  // shouldn't be added. Scraping bookmaker sites risks violating their
  // terms of service, is fragile (odds pages are JS-heavy and reshuffle
  // markup often, unlike a static news article), and is unnecessary —
  // licensed odds aggregators (The Odds API, and similar) exist
  // specifically so nobody has to scrape a bookmaker for this. As of
  // 2026-08-03 this is narrowed to a fallback result-score source only
  // (see resultsIngestion.ts) — it no longer supplies fixtures or odds to
  // the analysis prompt at all; current odds/market pricing comes
  // entirely from the model's own PRIMARY web search now (see
  // analyzeEvent.ts), which runs server-side on Anthropic's
  // infrastructure and isn't subject to this machine's own network
  // blocks the way a direct API call is.
  {
    id: "the-odds-api",
    category: "odds",
    type: "api",
    enabled: true,
    description:
      "Licensed odds+fixtures aggregator (the-odds-api.com) — FALLBACK ONLY as of 2026-08-03, used solely by resultsIngestion.ts for final-score results when ESPN can't resolve a fixture. Currently unreachable from this dev machine specifically (Zscaler blocks this domain — verified live, a network/environment issue, not an app bug). ODDS_REGIONS controls which bookmakers' odds come back (uk by default) for whatever still calls fetchOdds directly.",
  },

  // --- News ---
  // Multiple news sources can be enabled simultaneously — they all feed
  // the same pool (see getEnabledNewsProviders / runNewsIngestionCycle).
  {
    id: "bbc-sport-rss",
    category: "news",
    type: "rss",
    enabled: true,
    description:
      "One general BBC Sport football RSS feed, no key required — simplified from an earlier per-league/per-sport feed map now that the app is soccer-only. Feed URL lives in src/providers/news/index.ts.",
  },
  {
    id: "newsdata-io",
    category: "news",
    type: "api",
    enabled: false,
    description:
      "General/sports news API (newsdata.io). Disabled by default in favor of the simpler, keyless bbc-sport-rss. NewsDataIoProvider.ts still works if re-enabled + NEWSDATA_API_KEY set.",
  },
  {
    id: "newsapi",
    category: "news",
    type: "api",
    enabled: true,
    description:
      "General news API (newsapi.org). Re-enabled — runs alongside bbc-sport-rss, merged into the same de-duped-by-URL news pool (see newsIngestion.ts). Verified live 2026-07-31 (200, real articles) with NEWSAPI_KEY. Note: its free tier doesn't permit commercial use — fine for this app's current personal/non-commercial use, revisit if that changes.",
  },
  {
    id: "generic-scraper",
    category: "news",
    type: "scraper",
    enabled: false,
    description: "Generic/configurable HTML scraper template. Disabled by default and not pointed at a real site — fallback only, for a source with no api/rss option.",
  },

  // --- Stats ---
  // Wired into pick generation directly (src/lib/analyzeEvent.ts calls
  // every enabled stats provider for both teams) AND used during
  // ingestion for data-sufficiency scoring (src/lib/fixtureIngestion.ts).
  // Team-record/standings providers (ESPN record data, Wikipedia,
  // TheSportsDB) were removed early on in favor of real odds as the
  // primary signal for match-result markets; odds itself has since been
  // replaced by the model's own web search (see analyzeEvent.ts) —
  // corners/cards is the one thing search alone can't reliably quantify,
  // hence the one stats source left here.
  {
    id: "espn-match-stats",
    category: "stats",
    type: "api",
    enabled: true,
    usedForIngestionScoring: true,
    description:
      "Corners + cards (bookings) recent-form data, averaged over each team's last 5 completed matches, from ESPN's match-summary box score — no key required. Originally spec'd as a fbref.com scraper; fbref is behind a Cloudflare JS challenge (verified live twice, not fixable with headers), so this pulls the same underlying signal from ESPN's box score instead. Team-name resolution is exact-match against ESPN's own names, which can differ slightly from The Odds API's naming (e.g. accented characters) — occasional per-team misses are expected. See src/providers/stats/EspnMatchStatsProvider.ts.",
  },
  {
    id: "football-data",
    category: "stats",
    type: "api",
    enabled: true,
    usedForIngestionScoring: false,
    description:
      "Team form + standings from football-data.org (v4) — genuinely current data. Verified live 2026-07-31, re-checked 2026-08-01: free plan, 10 requests/minute, no observed daily cap. Covers 10 of this app's 21 tracked leagues: PL, La Liga, Serie A, Bundesliga, Ligue 1, Champions League, Primeira Liga, Eredivisie, English Championship, Brazilian Série A. NOT available on the free competition list (checked live, not assumed): Europa League, MLS, Scottish Premiership, Danish Superliga, Argentina, Saudi Arabia, Turkey, Belgium, Mexico, Japan, Norway. Prompt-time only. See src/providers/stats/FootballDataStatsProvider.ts.",
  },
  {
    id: "sportmonks",
    category: "stats",
    type: "api",
    enabled: true, // re-enabled 2026-08-07 — was disabled the same day for triggering false-disable noise across the 22 leagues it doesn't cover; now scoped via supportsSport() to only the 2 it actually does (Danish Superliga, Scottish Premiership), so it's never attempted (or penalized) outside those. Real, if narrow, value again instead of pure noise.
    usedForIngestionScoring: false,
    description:
      "Team form from sportmonks.com (Football v3). Verified live 2026-07-31, re-checked 2026-08-01: auth works (Football Free Plan active, 3000 req/hour), but the free plan's league entitlement covers only Danish Superliga + Scottish Premiership (and some cricket) — of this app's 21 tracked leagues, that's exactly 2: soccer_denmark_superliga and soccer_spl (added 2026-08-01), verified end-to-end with real fixture data. Every other tracked league still returns nothing on this plan — expected, not a bug. See src/providers/stats/SportMonksStatsProvider.ts.",
  },
  {
    id: "football-data-co-uk",
    category: "stats",
    type: "api",
    enabled: true,
    usedForIngestionScoring: false,
    description:
      "Match results from football-data.co.uk — genuinely open CSV data, no key, no auth, robots.txt confirmed fully permissive (checked live 2026-08-07, unlike fotmob.com/understat.com which explicitly disallow this and whoscored.com which bot-blocks despite a permissive robots.txt). Two depths: RICH (corners/cards/fouls/shots/referee) for 11 traditional European leagues, THIN (goals/result only) for 6 more (Argentina, MLS, Liga MX, Brazil, Denmark, Norway) — no continental competitions, no Saudi Arabia, Japan excluded for being months stale. See LEAGUE_MAP in src/providers/stats/FootballDataCoUkProvider.ts for the exact verified mapping.",
  },
  {
    id: "american-soccer-analysis",
    category: "stats",
    type: "api",
    enabled: true,
    usedForIngestionScoring: false,
    description:
      "Per-match xG (expected goals) for MLS only from americansocceranalysis.com — free, no key, real JSON API. This app's only xG source (SofaScore was removed 2026-08-08 — its 200-requests/~31-days quota didn't survive more than a few days against this app's actual pick volume); the other 23 tracked leagues still have no xG source (checked live 2026-08-07: Understat/FBref/WhoScored/FotMob/footystats.org/xGscore.io all ruled out by explicit robots.txt disallow or bot-detection; playerstats.football ruled out separately for an explicit ToS prohibition on scraping despite permissive robots.txt). See src/providers/stats/AmericanSoccerAnalysisProvider.ts.",
  },

  // --- Sentiment ---
  // No entries yet: SentimentProvider (src/providers/sentiment/SentimentProvider.ts)
  // is a scaffolded interface with no implementation — add a real source
  // here (and implement it) when one exists, following the stats/news
  // pattern above.

  // --- Weather ---
  // Wired into analyzeEvent.ts as its own prompt context block (wind/rain
  // called out as specifically relevant to goals and corners markets).
  // Not part of DataSourceHealth's ingestion-time sources (like the stats
  // sources above, it's on-demand/prompt-time only) but still tracked via
  // the same shouldAttempt/recordAttempt calls from analyzeEvent.ts.
  {
    id: "openweathermap",
    category: "weather",
    type: "api",
    enabled: true,
    description:
      "Kickoff-time forecast (temperature, precipitation chance, wind speed) from openweathermap.org's free 5-day/3-hour endpoint. Verified live 2026-07-31 — the key 401'd for its first few minutes (OpenWeatherMap's documented new-key activation delay, up to ~2h) then returned real forecast data once active. City is derived from the home team's venue via ESPN schedule data (see resolveHomeVenueCity in src/providers/espn/espnLeagueMap.ts), since this app's Event model has no venue field. See src/providers/weather/OpenWeatherMapProvider.ts.",
  },
];
