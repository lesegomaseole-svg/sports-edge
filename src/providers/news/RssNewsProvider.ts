/**
 * News provider backed by one or more flat RSS feed URLs — not
 * sport-scoped. Every configured feed is queried regardless of which
 * sport/team the caller asks about; this app is soccer-only, so one
 * general football feed already covers every tracked league (simplified
 * from an earlier per-sport feed map, when the app covered several
 * different sports with genuinely different feeds).
 */
import Parser from "rss-parser";
import { NewsProvider, NormalizedNewsItem } from "./NewsProvider";

export class RssNewsProvider implements NewsProvider {
  readonly name = "rss";

  private readonly parser = new Parser();

  constructor(private readonly feedUrls: string[]) {}

  async fetchNews(): Promise<NormalizedNewsItem[]> {
    const items: NormalizedNewsItem[] = [];

    for (const url of this.feedUrls) {
      try {
        const feed = await this.parser.parseURL(url);
        for (const entry of feed.items) {
          if (!entry.link || !entry.title) continue;
          items.push({
            title: entry.title,
            summary: entry.contentSnippet ?? entry.content ?? undefined,
            url: entry.link,
            source: feed.title ?? "RSS",
            publishedAt: entry.isoDate ?? (entry.pubDate ? new Date(entry.pubDate).toISOString() : new Date().toISOString()),
          });
        }
      } catch (err) {
        console.error(`[RssNewsProvider] failed to parse feed ${url}:`, (err as Error).message);
      }
    }

    return items;
  }
}
