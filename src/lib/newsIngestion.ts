/**
 * Pulls news scoped to each actively-tracked sport (by title, since that
 * reads better as a search query than the raw provider key) from every
 * enabled news source (src/config/dataSources.ts) and stores it. Multiple
 * sources can be enabled at once — their results are merged into one pool,
 * de-duped on URL across all of them combined (not per source), so
 * repeated polls — or overlapping articles from different sources — don't
 * spam the DB with duplicates.
 *
 * Health-tracked as "bbc-sport-rss" (see dataSourceHealth.ts) — the one
 * news source enabled by default as of this pivot. Gated by
 * shouldAttempt() before running at all, reported once per cycle based on
 * whether the cycle found any items anywhere.
 */
import { prisma } from "../db/client";
import { getEnabledNewsProviders } from "../providers/news";
import { shouldAttempt, recordAttempt } from "./dataSourceHealth";

const NEWS_SOURCE_ID = "bbc-sport-rss";

const providers = getEnabledNewsProviders();

export async function runNewsIngestionCycle(): Promise<{ items: number }> {
  if (providers.length === 0) {
    return { items: 0 };
  }

  if (!(await shouldAttempt(NEWS_SOURCE_ID))) {
    console.warn(`[newsIngestion] "${NEWS_SOURCE_ID}" is disabled and not yet due for its 24h retry — skipping this cycle.`);
    return { items: 0 };
  }

  const activeSports = await prisma.sport.findMany({
    where: { trackedMarkets: { some: { enabled: true } } },
  });

  let count = 0;
  let foundAny = false;
  const seenUrls = new Set<string>();

  for (const sport of activeSports) {
    for (const provider of providers) {
      const items = await provider.fetchNews(sport.title, sport.key);
      if (items.length > 0) foundAny = true;

      for (const item of items) {
        if (seenUrls.has(item.url)) continue;
        seenUrls.add(item.url);

        const exists = await prisma.newsItem.findFirst({ where: { url: item.url } });
        if (exists) continue;

        await prisma.newsItem.create({
          data: {
            sportKey: sport.key,
            title: item.title,
            summary: item.summary,
            url: item.url,
            source: item.source,
            publishedAt: new Date(item.publishedAt),
          },
        });
        count++;
      }
    }
  }

  await recordAttempt(NEWS_SOURCE_ID, foundAny);

  return { items: count };
}
