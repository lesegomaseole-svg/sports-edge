import express from "express";
import cors from "cors";
import path from "path";
import { sportsRouter } from "./routes/sports";
import { marketsRouter } from "./routes/markets";
import { eventsRouter } from "./routes/events";
import { oddsRouter } from "./routes/odds";
import { picksRouter } from "./routes/picks";
import { fixturesRouter } from "./routes/fixtures";
import { dataSourceHealthRouter } from "./routes/dataSourceHealth";
import { analysisRouter } from "./routes/analysis";
import { authGate } from "./authMiddleware";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // GET /api/health deliberately sits BEFORE the auth gate — Caddy/an
  // uptime check/a load balancer hitting this shouldn't need the shared
  // secret just to confirm the process is alive. It reveals nothing beyond
  // "the server is up," same as before this gate existed.
  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.use(authGate);

  app.use("/api/sports", sportsRouter);
  app.use("/api/markets", marketsRouter);
  app.use("/api/events", eventsRouter);
  app.use("/api/odds", oddsRouter);
  app.use("/api/picks", picksRouter);
  app.use("/api/fixtures", fixturesRouter);
  app.use("/api/data-sources", dataSourceHealthRouter);
  app.use("/api/analysis", analysisRouter);

  // Static market-management dashboard.
  app.use(express.static(path.join(__dirname, "..", "..", "public")));

  return app;
}
