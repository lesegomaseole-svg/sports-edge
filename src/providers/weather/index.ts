import { WeatherProvider } from "./WeatherProvider";
import { OpenWeatherMapProvider } from "./OpenWeatherMapProvider";
import { DATA_SOURCES } from "../../config/dataSources";

/**
 * Returns the enabled weather source (per src/config/dataSources.ts), if
 * any — same enable/disable pattern as stats/news, sized down to a single
 * getter since there's exactly one weather source today.
 */
export function getEnabledWeatherProvider(): WeatherProvider | null {
  const source = DATA_SOURCES.find((s) => s.category === "weather" && s.enabled);
  if (!source) return null;

  switch (source.id) {
    case "openweathermap": {
      const apiKey = process.env.OPENWEATHERMAP_API_KEY;
      if (!apiKey) {
        console.warn("[weather] 'openweathermap' is enabled in dataSources.ts but OPENWEATHERMAP_API_KEY is not set — skipping.");
        return null;
      }
      return new OpenWeatherMapProvider(apiKey);
    }
    default:
      console.warn(`[weather] unknown enabled data source id "${source.id}" — no provider wired for it.`);
      return null;
  }
}

export * from "./WeatherProvider";
