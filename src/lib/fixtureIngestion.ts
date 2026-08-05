/**
 * PRIMARY ingestion cycle: discovers fixtures from ESPN (see
 * EspnFixtureProvider — no key required), bounded to TODAY ONLY (from now
 * until the end of the current UTC calendar day) via the fixture
 * provider's own date-bounded fetch.
 *
 * Renamed from oddsIngestion.ts (2026-08-03): fixture discovery used to be
 * fully coupled to The Odds API (the one call that both listed fixtures
 * AND supplied odds) until that domain got blocked at the network level
 * (Zscaler content-category filter on api.the-odds-api.com — confirmed
 * live, not an app bug, not a quota/key issue). Since a blocked odds
 * vendor meant zero new fixtures at all, not just missing odds, fixture
 * discovery was decoupled onto its own source (ESPN, already proven
 * reachable through the same network) — restoring the architecture this
 * app's own earlier comments already described as the intended design
 * (see espnLeagueMap.ts, FixtureProvider.ts). Odds are no longer fetched
 * at ingestion time at all: the analysis prompt's PRIMARY web search
 * already covers "current odds/betting market prices" as one of its named
 * search targets (see analyzeEvent.ts), which was proven live to find
 * real odds prices even while The Odds API itself was unreachable from
 * this machine — search runs server-side on Anthropic's infrastructure,
 * never touching this machine's network stack, so it isn't affected by
 * this or any future local network block the same way a direct API call
 * would be.
 *
 * Every NEW fixture is scored for data sufficiency BEFORE being
 * persisted (avoids a foreign-key deletion hazard on a later cycle for a
 * fixture that already has a Pick attached). Score components (max 2,
 * down from 3 — the odds-bookmaker-count signal is gone along with the
 * odds fetch itself; MIN_DATA_SCORE stays at 1, so either signal alone
 * still qualifies a fixture):
 *   - +1 if corners/cards data (EspnMatchStatsProvider) was found for
 *     either team.
 *   - +1 if there's any recent news for the sport.
 * Rejected fixtures aren't blacklisted — since they're never created,
 * they're simply re-scored fresh on the next cycle (still within the
 * window), so a fixture that picks up news overnight gets a real second
 * chance, not a permanent skip.
 *
 * Source health: every cycle checks dataSourceHealth.shouldAttempt() for
 * "espn-fixtures" before calling it at all, and for "espn-match-stats"
 * before using it for sufficiency scoring — then reports the outcome via
 * recordAttempt() once per cycle per source (not per league), so one
 * legitimately-quiet league doesn't get mistaken for the whole source
 * being broken as long as other leagues in the same cycle return real
 * data. See dataSourceHealth.ts.
 *
 * fixturesSucceeded (fixed 2026-08-04): a genuinely empty result (no
 * fixtures scheduled for a league today) and a genuine fetch failure used
 * to look identical here — provider.fetchFixturesForSport() caught its own
 * errors and returned [] either way, so a real off-day across every
 * tracked league (confirmed live via direct ESPN checks — see the D3
 * audit finding) was indistinguishable from espn-fixtures actually being
 * down, and got recorded as a failure toward the 3-strike auto-disable
 * either way. The provider now throws on a genuine error instead of
 * swallowing it (see FixtureProvider.ts), so the per-sport try/catch below
 * can tell them apart: fixturesSucceeded is true as soon as ANY sport's
 * call completes without throwing, however many fixtures it returns —
 * only a sport whose call actually throws counts against the source.
 */
import { prisma } from "../db/client";
import { getFixtureProvider } from "../providers/fixtures";
import { getIngestionScoringStatsProviders } from "../providers/stats";
import { shouldAttempt, recordAttempt } from "./dataSourceHealth";

const FIXTURE_SOURCE_ID = "espn-fixtures";
const STATS_SOURCE_ID = "espn-match-stats";
const MIN_DATA_SCORE = 1;

const provider = getFixtureProvider();
// Deliberately NOT getEnabledStatsProviders() — the 3 quota-constrained
// stats sources (api-football, sportmonks, football-data) opt out of
// ingestion-time scoring via usedForIngestionScoring:false in
// dataSources.ts, since this loop runs per new fixture across every
// tracked league and would exhaust e.g. API-Football's 100/day budget
// almost immediately. Prompt-time analysis (analyzeEvent.ts) still uses
// all of them via getEnabledStatsProviders().
const statsProviders = getIngestionScoringStatsProviders();

export async function runFixtureIngestionCycle(): Promise<{ ingested: number; rejectedInsufficientData: number }> {
  if (!(await shouldAttempt(FIXTURE_SOURCE_ID))) {
    console.warn(`[fixtureIngestion] "${FIXTURE_SOURCE_ID}" is disabled and not yet due for its 24h retry — skipping this cycle.`);
    return { ingested: 0, rejectedInsufficientData: 0 };
  }

  const statsAllowed = statsProviders.length > 0 && (await shouldAttempt(STATS_SOURCE_ID));
  if (statsProviders.length > 0 && !statsAllowed) {
    console.warn(`[fixtureIngestion] "${STATS_SOURCE_ID}" is disabled and not yet due for its 24h retry — skipping corners/cards scoring this cycle.`);
  }

  const trackedSports = await prisma.sport.findMany({
    where: { trackedMarkets: { some: { enabled: true } } },
  });

  let ingested = 0;
  let rejectedInsufficientData = 0;
  let fixturesSucceeded = false;
  let statsSucceeded = false;
  // Distinct from statsSucceeded: the stats loop below only runs for NEW
  // fixtures (existing ones just update and `continue`). A cycle that
  // happens to find zero new fixtures never calls a stats provider at all
  // — recordAttempt(false) must NOT fire in that case, or a perfectly
  // healthy source gets penalized for cycles where it was never actually
  // attempted (this exact false-disable pattern hit espn-match-stats and
  // results-espn earlier — see dataSourceHealth.ts / resultsIngestion.ts).
  let statsAttempted = false;

  for (const sport of trackedSports) {
    let fixtures: Awaited<ReturnType<typeof provider.fetchFixturesForSport>>;
    try {
      fixtures = await provider.fetchFixturesForSport(sport.key);
      fixturesSucceeded = true; // reached without throwing — a real response, even if empty
    } catch (err) {
      console.error(`[fixtureIngestion] fetchFixturesForSport failed for "${sport.key}":`, (err as Error).message);
      continue; // this league's fetch genuinely failed; try the rest of the cycle
    }

    for (const fx of fixtures) {
      const existing = await prisma.event.findUnique({ where: { externalId: fx.externalId } });

      if (existing) {
        await prisma.event.update({
          where: { id: existing.id },
          data: { homeTeam: fx.homeTeam, awayTeam: fx.awayTeam, commenceTime: new Date(fx.commenceTime) },
        });
        ingested++;
        continue;
      }

      let cornersCardsFound = false;
      if (statsAllowed) {
        statsAttempted = true;
        for (const sp of statsProviders) {
          const [home, away] = await Promise.all([
            sp.fetchTeamStats(fx.homeTeam, sport.key).catch(() => null),
            sp.fetchTeamStats(fx.awayTeam, sport.key).catch(() => null),
          ]);
          if (home?.raw || away?.raw) {
            cornersCardsFound = true;
            statsSucceeded = true;
          }
        }
      }

      const newsCount = await prisma.newsItem.count({ where: { sportKey: sport.key } });
      const dataScore = (cornersCardsFound ? 1 : 0) + (newsCount > 0 ? 1 : 0);

      if (dataScore < MIN_DATA_SCORE) {
        rejectedInsufficientData++;
        continue;
      }

      await prisma.event.create({
        data: {
          externalId: fx.externalId,
          sportId: sport.id,
          homeTeam: fx.homeTeam,
          awayTeam: fx.awayTeam,
          commenceTime: new Date(fx.commenceTime),
          hasSufficientData: true,
          dataScore,
        },
      });
      ingested++;
    }
  }

  await recordAttempt(FIXTURE_SOURCE_ID, fixturesSucceeded);
  if (statsAllowed && statsAttempted) {
    await recordAttempt(STATS_SOURCE_ID, statsSucceeded);
  }

  return { ingested, rejectedInsufficientData };
}
