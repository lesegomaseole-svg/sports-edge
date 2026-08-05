import "dotenv/config";
import { createApp } from "./api/app";
import { startFixtureScheduler } from "./scheduler/fixtureScheduler";
import { startNewsScheduler } from "./scheduler/newsScheduler";
import { startResultsScheduler } from "./scheduler/resultsScheduler";
import { startClvScheduler } from "./scheduler/clvScheduler";
import { getOddsProvider } from "./providers/odds";
import { DATA_SOURCES } from "./config/dataSources";
import { prisma } from "./db/client";

const PORT = Number(process.env.PORT || 3000);

const app = createApp();

app.listen(PORT, () => {
  const enabledNewsIds = DATA_SOURCES.filter((s) => s.category === "news" && s.enabled).map((s) => s.id);

  console.log(`Sports Edge running at http://localhost:${PORT}`);
  console.log(`  Fixtures:       espn-fixtures (no key required), soccer-only, 21 leagues, bounded to today's fixtures only`);
  console.log(`  Odds:           ${getOddsProvider()?.name ?? "disabled"} — used for CLV tracking (src/lib/clv.ts) and as a results fallback only; the analysis prompt gets market pricing from search now, fixtures don't depend on this at all`);
  console.log(`  News sources:   ${enabledNewsIds.join(", ") || "none enabled"} (actual usability logged per-source below)`);
  console.log(`  Agent provider: claude-code (subscription-billed via the \`claude\` CLI — see src/agents/ClaudeCodeAgent.ts)`);

  startFixtureScheduler();
  startNewsScheduler();
  startResultsScheduler();
  startClvScheduler();
  void warnIfSourcesDisabled();
  warnIfAuthUnset();
});

// See src/api/authMiddleware.ts — enforcement is entirely gated on this
// env var being set, so a deployment that forgets to set it fails open
// (API and dashboard both reachable with no secret) rather than failing
// closed. That's the right default for local dev, which has run
// unauthenticated all along, but it's a silent gap on a real deployment —
// this is the one place that gap gets said out loud instead.
function warnIfAuthUnset() {
  if (!process.env.AUTH_SHARED_SECRET) {
    console.warn(
      "[startup] AUTH_SHARED_SECRET is not set — the API and dashboard are running with NO authentication. Fine for local dev; set this before exposing the app to the internet."
    );
  }
}

// Every prior instance of the false-disable bug (results-espn,
// results-odds-scores, espn-fixtures, bbc-sport-rss, espn-match-stats,
// sofascore) was found by accident, days after the fact, during unrelated
// work — never by anything actively looking for it. This surfaces current
// state loudly at every boot instead, which given how often this dev
// process gets restarted is a tight feedback loop in practice, not a
// once-a-day check. Doesn't fix the underlying misclassification (a
// disabled source may still be genuinely healthy — see
// fixtureIngestion.ts's fixturesSucceeded), just makes "is anything
// currently disabled" impossible to miss instead of something you have to
// think to go look up.
async function warnIfSourcesDisabled() {
  const disabled = await prisma.dataSourceHealth.findMany({ where: { disabled: true } });
  if (disabled.length === 0) return;
  console.warn(`[startup] ${disabled.length} data source(s) currently DISABLED — see GET /api/data-sources/health:`);
  for (const s of disabled) {
    // disabledReason (added 2026-08-04): "quota_exhausted" means the
    // provider's own request budget hit zero, not a real outage — see
    // dataSourceHealth.ts's recordAttempt comment. Worth a different
    // message so this doesn't read the same as an actual broken source.
    const detail =
      s.disabledReason === "quota_exhausted"
        ? "quota exhausted, not a real outage — will resume once the provider's quota resets"
        : `${s.consecutiveFailures} consecutive failures, last attempt ${s.lastAttemptAt?.toISOString() ?? "unknown"}`;
    console.warn(`  - ${s.sourceId} (${detail})`);
  }
}
