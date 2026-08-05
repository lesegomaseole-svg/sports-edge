/**
 * Generic, configurable HTML scraper template for news headlines. NOT
 * pointed at a real site by default — disabled in src/config/dataSources.ts
 * ("generic-scraper") and instantiated with empty config in
 * src/providers/news/index.ts. It's a starting point: point it at a
 * specific listing page and CSS selectors when you actually need it.
 *
 * IMPORTANT — before enabling this against any real site:
 *   - Check that site's robots.txt and terms of service. Many sites
 *     explicitly disallow scraping; treat that as a hard no, not a
 *     technicality.
 *   - Keep request rate low — this runs on the app's news poll schedule,
 *     so don't point it at something that expects human-paced traffic.
 *   - Prefer an official API or RSS feed over scraping whenever one
 *     exists (see the type preference order in src/config/dataSources.ts).
 */
import axios from "axios";
import { load } from "cheerio";
import { NewsProvider, NormalizedNewsItem } from "./NewsProvider";

export interface ScraperSelectors {
  item: string; // selector for each headline "row"/card on the listing page
  headline: string; // selector (relative to item) for the headline text
  link: string; // selector (relative to item) for the <a href>
  date?: string; // optional selector (relative to item) for a date/time string
}

export class ScraperNewsProvider implements NewsProvider {
  readonly name = "scraper";

  constructor(
    private readonly baseUrl: string,
    private readonly selectors: ScraperSelectors
  ) {}

  async fetchNews(): Promise<NormalizedNewsItem[]> {
    if (!this.baseUrl) return [];

    try {
      const { data: html } = await axios.get<string>(this.baseUrl, {
        timeout: 10_000,
        headers: { "User-Agent": "sports-edge-bot/0.1 (advisory research tool)" },
      });
      const $ = load(html);
      const items: NormalizedNewsItem[] = [];
      const sourceHost = new URL(this.baseUrl).hostname;

      $(this.selectors.item).each((_, el) => {
        const node = $(el);
        const headline = node.find(this.selectors.headline).first().text().trim();
        const href = node.find(this.selectors.link).first().attr("href");
        if (!headline || !href) return;

        const url = /^https?:\/\//.test(href) ? href : new URL(href, this.baseUrl).toString();
        const dateText = this.selectors.date ? node.find(this.selectors.date).first().text().trim() : "";
        const parsedDate = dateText && !isNaN(Date.parse(dateText)) ? new Date(dateText).toISOString() : new Date().toISOString();

        items.push({
          title: headline,
          url,
          source: sourceHost,
          publishedAt: parsedDate,
        });
      });

      return items;
    } catch (err) {
      console.error(`[ScraperNewsProvider] fetchNews failed for ${this.baseUrl}:`, (err as Error).message);
      return [];
    }
  }
}
