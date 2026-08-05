/**
 * Kickoff-time weather forecast from https://openweathermap.org (free
 * 5-day/3-hour forecast endpoint). Wired into analyzeEvent.ts as a new
 * context block — wind and rain are specifically relevant to goals and
 * corners markets (heavier conditions tend to suppress fluid attacking
 * play and open-play chance creation, and push more play out wide/set
 * pieces), so the prompt calls that out explicitly.
 *
 * Verified live 2026-07-31 with the real key behind OPENWEATHERMAP_API_KEY:
 *   - The key returned 401 "Invalid API key" for its first ~few minutes
 *     after being added to .env — OpenWeatherMap's newly-created keys are
 *     documented to take up to ~2 hours to activate. Retried and
 *     confirmed 200 with real forecast data shortly after.
 *   - No rate-limit info is exposed in this endpoint's response headers.
 *     Per OpenWeatherMap's own published free-tier limits (not something
 *     observable from a single live call): 60 calls/minute, 1,000,000
 *     calls/month.
 *   - The endpoint returns 40 entries at 3-hour resolution (5 days
 *     forward) — comfortably covers this app's fixture window (today
 *     only, as of 2026-08-01; was a rolling 3-day window before).
 *
 * City resolution is the caller's job (see resolveHomeVenueCity in
 * espnLeagueMap.ts) — this provider just takes whatever city string it's
 * given and queries OpenWeatherMap's city-name search directly (no
 * explicit country code), which is the same "exact-ish name match, some
 * misses expected" tradeoff EspnMatchStatsProvider makes on team names —
 * a handful of city names are ambiguous across countries without a
 * country hint, and this doesn't try to disambiguate further.
 */
import axios from "axios";
import { WeatherForecast, WeatherProvider } from "./WeatherProvider";

const BASE_URL = "https://api.openweathermap.org/data/2.5/forecast";
const MAX_ACCEPTABLE_GAP_MS = 24 * 60 * 60 * 1000; // beyond this, the closest slot is too far from kickoff to be meaningful

interface ForecastEntry {
  dt: number; // unix seconds
  main: { temp: number; feels_like: number };
  weather: { main: string; description: string }[];
  wind: { speed: number; gust?: number }; // m/s
  pop: number; // probability of precipitation, 0-1
  dt_txt: string;
}
interface ForecastResponse {
  cod: string;
  list: ForecastEntry[];
}

export class OpenWeatherMapProvider implements WeatherProvider {
  readonly name = "openweathermap";

  constructor(private readonly apiKey: string) {
    if (!apiKey) {
      throw new Error("OpenWeatherMapProvider requires OPENWEATHERMAP_API_KEY to be set");
    }
  }

  async fetchForecast(city: string, kickoff: Date): Promise<WeatherForecast | null> {
    try {
      const { data } = await axios.get<ForecastResponse>(BASE_URL, {
        params: { q: city, units: "metric", appid: this.apiKey },
        timeout: 10_000,
      });

      if (!data.list || data.list.length === 0) return null;

      const kickoffMs = kickoff.getTime();
      const closest = data.list.reduce((best, entry) =>
        Math.abs(entry.dt * 1000 - kickoffMs) < Math.abs(best.dt * 1000 - kickoffMs) ? entry : best
      );

      const gapMs = Math.abs(closest.dt * 1000 - kickoffMs);
      if (gapMs > MAX_ACCEPTABLE_GAP_MS) {
        console.warn(`[OpenWeatherMapProvider] closest forecast slot for "${city}" is ${(gapMs / 3_600_000).toFixed(1)}h from kickoff — too far out, skipping.`);
        return null;
      }

      const windKmh = (closest.wind.speed * 3.6).toFixed(0);
      const precipPct = (closest.pop * 100).toFixed(0);
      const description = closest.weather[0]?.description ?? "unknown conditions";

      return {
        city,
        summary: `${city} at kickoff (forecast for ${closest.dt_txt} UTC, nearest available slot): ${description}, ${closest.main.temp.toFixed(1)}°C (feels like ${closest.main.feels_like.toFixed(1)}°C), ${precipPct}% chance of precipitation, wind ${windKmh} km/h${closest.wind.gust ? ` (gusts ${(closest.wind.gust * 3.6).toFixed(0)} km/h)` : ""}.`,
        raw: { ...closest, gapMs },
      };
    } catch (err) {
      console.error(`[OpenWeatherMapProvider] fetchForecast failed for "${city}":`, (err as Error).message);
      return null;
    }
  }
}
