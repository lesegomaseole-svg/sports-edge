# Sports Edge

AI-assisted sports betting analysis. Node/TypeScript backend that tracks fixtures and odds across sports/markets you choose, pulls relevant news, and uses Claude (via the Claude Code CLI, subscription-billed — see `src/agents/ClaudeCodeAgent.ts`) to produce advisory pick recommendations with reasoning and a confidence score. **Advisory only — it never places bets.** Designed to add a second vertical (forex market analysis) later on the same architecture.

## How it's built

- `src/config/dataSources.ts` — the central registry of every data source in the system (odds, news, stats, sentiment): id, category, type (`api` / `rss` / `scraper`), and whether it's enabled. This is the one place to add a new source or turn one on/off — see "Data sources" below.
- **No mock data anywhere in the app.** Every provider is either a real implementation or doesn't exist. An unconfigured/missing-key/uncovered source is skipped with a clear log message (or, for the AI agent, a thrown error) — it never silently substitutes fake data.
- `src/providers/fixtures` — which events exist, decoupled from odds entirely (restored 2026-08-03 after a period where fixture discovery had drifted onto being fully coupled to the odds provider — see `fixtureIngestion.ts`'s file header for why). `EspnFixtureProvider` pulls real fixtures from ESPN's public (undocumented, no-key) scoreboard endpoints. `getFixtureProvider().fetchFixturesForSport()` (`src/providers/fixtures/index.ts`) returns real fixtures for every sport in `ESPN_LEAGUE_BY_SPORT_KEY`. See `src/providers/espn/espnLeagueMap.ts` for exact sport coverage and how each endpoint was verified.
- `src/providers/odds` — as of 2026-08-03, fallback-only: `resultsIngestion.ts` still calls it for final-score results when ESPN can't resolve a fixture. It no longer supplies fixtures or feeds the analysis prompt at all — current odds/market pricing comes entirely from the model's own web search now (see `analyzeEvent.ts`). `TheOddsApiProvider` is the only implementation; with no key configured, `getOddsProvider()` returns `null` and that fallback simply doesn't run. Odds is API-only by design — no scraper implementation exists or should be added (see comment in `dataSources.ts`).
- `src/providers/news` — same pattern for news, but unlike odds it's a *registry*, not a single active provider: `getEnabledNewsProviders()` returns every news source currently enabled in `dataSources.ts` (`NewsDataIoProvider`, `RssNewsProvider` x3 for BBC Sport + ESPN NBA + ESPN Cricinfo, `NewsApiProvider`/`ScraperNewsProvider` if re-enabled), and their results are merged into one pool. If none end up enabled/usable it returns an empty array — 0 items that cycle, not fake ones.
- `src/providers/stats` — same registry pattern again: `getEnabledStatsProviders()` (`src/providers/stats/index.ts`) returns every enabled stats source — `EspnStatsProvider`, `WikipediaStatsProvider`, `TheSportsDbStatsProvider`, all real, no key required for any of them. Unlike news, results aren't merged into one pool: `analyzeEvent.ts` queries every enabled provider for both teams and gives each one its own labeled block in the prompt (there's no reliable dedup key for prose stats the way there is for a news URL, and knowing which source said what matters). Each provider returns `null` per-team (not fake stats) when unsupported/unresolvable. `src/providers/sentiment` remains scaffolded only (interface, zero implementations, and absent from the registry) — the next source to follow this same pattern.
- `src/agents` — the LLM layer. `ClaudeCodeAgent` (shells out to the `claude` CLI, subscription-billed) is the only implementation as of 2026-08-02 — a prior multi-provider setup (Gemini/direct-Claude-API/OpenAI with a `FallbackAgent` wrapper) was removed after all three metered paths sat unusable for a day while Claude Code worked reliably; see `src/agents/index.ts`'s header for the full reasoning if reintroducing a second provider later. The LLM synthesizes stats + news + its own web search into a recommendation — as of 2026-08-03 there's no structured odds feed at all, so market pricing is whatever the model's PRIMARY web search finds (see `analyzeEvent.ts`), not something computed in code. With the CLI missing/unauthenticated, `getAgentProvider()`'s result throws a clear error (surfaced as a 500 from `POST /api/picks/generate`) instead of returning placeholder output.
- `src/scheduler` — polling jobs. Fixtures (`fixtureScheduler.ts`) poll once daily by default (`FIXTURE_POLL_INTERVAL_HOURS`, fits the "today only" fixture window); news every 15 minutes. Only *tracked* (enabled) markets are polled, so cost/rate-limit usage stays bounded as you add sports.
- `prisma/schema.prisma` — SQLite for local dev (zero setup); swapping to Postgres later is a one-line `DATABASE_URL` change, no code changes.
- `public/index.html` — the dashboard: Market Manager (toggle which sport/market combos are tracked), Upcoming Fixtures (browse events, generate a pick on demand), AI Picks (recommendation feed).

Switching which news sources are active is one boolean in `src/config/dataSources.ts` — nothing else in the app changes. Fixtures and the AI agent need no provider switch at all: ESPN and Claude Code are the only implementations of each.

## Data sources

`src/config/dataSources.ts` is the single place to see, add, or toggle every data source in the system. Each entry has an `id`, `category` (`fixtures` | `odds` | `news` | `stats` | `sentiment`), `type`, `enabled` flag, and `description`.

Source types, in order of preference — prefer the earlier ones whenever there's a choice:

1. **api** — licensed/official, stable shape, sanctioned usage. Always prefer this when one exists.
2. **rss** — public, low-maintenance, no ToS ambiguity. Good second choice when there's no API.
3. **scraper** — fragile (breaks whenever the target site's markup changes) and carries ToS/legal risk. Fallback-only: use it only when a source has no api/rss option, and only after checking that site's `robots.txt` and terms of service. `generic-scraper` in the registry is a disabled-by-default template for this — see `src/providers/news/ScraperNewsProvider.ts`.

There's no `mock` type — every registry entry is a real source. Something not configured (missing key, sport not covered) just produces no data for that source, clearly logged, rather than a fabricated placeholder.

For news specifically, multiple sources can be enabled simultaneously — by default that's `newsdata-io`, `bbc-sport-rss`, `espn-nba-rss`, and `cricinfo-rss` all running at once (`newsapi` and `generic-scraper` also exist in the registry but are disabled by default). `getEnabledNewsProviders()` instantiates whichever are turned on, and `runNewsIngestionCycle` merges + de-dupes their results by URL across all of them combined.

`stats` is wired into pick generation directly (`analyzeEvent.ts` calls `getEnabledStatsProviders()`) rather than through a per-cycle scheduler. Three sources are enabled by default — `espn-stats`, `wikipedia-stats`, `thesportsdb-stats` — none requiring a key or signup (`thesportsdb-stats` uses TheSportsDB's own published shared test key). Unlike news, these aren't merged into one pool: each provider gets its own labeled block in the prompt. `sentiment` remains scaffolded (`SentimentProvider` interface only, no implementation, no registry entry) — the pattern for whichever source follows.

Of everything in the registry, only `the-odds-api` (now fallback-only, see above) and `newsdata-io`/`newsapi` need real credentials — every RSS feed, every stats source, and fixtures itself (`espn-fixtures`) work with zero signups.

Sport coverage for `espn-fixtures`/`espn-match-stats` lives in `src/providers/espn/espnLeagueMap.ts`, not per-entry in the registry above, since both providers need to agree on the exact same ESPN sport+league per sportKey.

## Setup

```bash
npm install
cp .env.example .env
npm run prisma:migrate   # creates the local SQLite DB
npm run seed              # loads the sport catalog (EPL, NBA, ATP active by default)
npm run dev
```

Open http://localhost:3000. With zero API keys: fixtures (ESPN), news (BBC RSS), and team stats (ESPN) all populate for real. AI pick generation needs the `claude` CLI installed and logged in (see below) — there's no mock fallback. Odds/market pricing needs no setup at all: it comes from the model's own web search now, not a separate provider.

## Adding real data

Edit `.env` for optional extras and API keys:

```
NEWSDATA_API_KEY=your_key       # https://newsdata.io
NEWSAPI_KEY=your_key            # https://newsapi.org — legacy/optional, see below

CLAUDE_CODE_BIN=                # absolute path to the `claude` binary if it's not on PATH — see ClaudeCodeAgent.ts

# Optional — only used as a fallback result source in resultsIngestion.ts,
# not for fixtures or odds at all anymore (see "How it's built" above).
THE_ODDS_API_KEY=your_key       # https://the-odds-api.com
```

News works out of the box without any key: `bbc-sport-rss` (RSS, no credentials needed) is enabled by default alongside `newsdata-io`, which is enabled but just skipped until `NEWSDATA_API_KEY` is set. `newsapi` is disabled by default (its free tier doesn't permit commercial use) but `NewsApiProvider.ts` is kept and can be re-enabled in `src/config/dataSources.ts` if you'd rather use it. Enabling `generic-scraper` requires filling in a real base URL + selectors in `src/providers/news/index.ts` first — see the comments there.

The AI agent needs no API key at all: `getAgentProvider()` always returns `ClaudeCodeAgent`, which shells out to the `claude` CLI and bills against a Claude Pro/Max subscription's included usage. Install it (`npm install -g @anthropic-ai/claude-code`), run `claude` once to log in, and pick generation works — no `.env` entry required for the agent itself. If a bare `claude` isn't resolving (common with a custom npm global prefix that only your shell's rc file puts on PATH — a process manager won't source that), set `CLAUDE_CODE_BIN` to the absolute path from `which claude`.

Restart the server. No other changes needed.

## Managing markets

The **Market Manager** tab lists every sport in the catalog (`prisma/seed.ts` — currently ~18 sports across soccer, basketball, tennis, NFL, MLB, NHL, MMA, boxing, cricket, rugby) grouped by category, with a toggle per market type (moneyline / spreads / totals). Only toggled-on combinations get polled. To add a sport not in the seed list, add it to `SPORTS` in `src/db/seed.ts` (key must match the odds provider's sport key) and re-run `npm run seed`.

## Extending to forex (phase 2)

The plan is to reuse this same shape: `src/providers/market-data` (forex price feeds), `src/providers/economic-calendar`, and the existing `src/agents` layer, with a parallel `analyzeForexPair.ts` that computes technical indicators in code (moving averages, RSI, etc.) the same way `analyzeEvent.ts` computes implied probability, then hands that + macro news to the LLM for synthesis. Not built yet — this repo is sports-only for now.

## Notes

- This tool is advisory only by design. It does not place bets or execute trades.
- Sports betting/prediction tools may be subject to gambling-related regulation depending on your jurisdiction, especially if you ever share recommendations with other users. Worth checking local rules if you take this past personal use.
