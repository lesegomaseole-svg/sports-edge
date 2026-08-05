import { EspnFixtureProvider } from "./EspnFixtureProvider";

// Single implementation as of 2026-08-03 — no key/config needed, so
// there's no "unconfigured" case to handle the way getOddsProvider() has
// to. If a second fixture source is ever added, this becomes a registry
// (merge results, same pattern as src/providers/news/index.ts) rather
// than a fixed single instance.
const provider = new EspnFixtureProvider();

export function getFixtureProvider() {
  return provider;
}

export * from "./FixtureProvider";
