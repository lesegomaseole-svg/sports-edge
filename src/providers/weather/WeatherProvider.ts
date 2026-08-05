export interface WeatherForecast {
  city: string;
  summary: string; // human-readable text, suitable for an agent prompt
  raw?: Record<string, unknown>;
}

export interface WeatherProvider {
  readonly name: string;
  fetchForecast(city: string, kickoff: Date): Promise<WeatherForecast | null>;
}
