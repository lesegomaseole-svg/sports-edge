import { Router } from "express";
import { computeCalibrationReport } from "../../lib/calibration";
import { computeClvReport } from "../../lib/clv";

export const analysisRouter = Router();

// Track-record / calibration reporting — see calibration.ts for the exact
// math and src/db/schema.prisma's Pick.outcome for what "settled" means.
analysisRouter.get("/calibration", async (_req, res) => {
  const report = await computeCalibrationReport();
  res.json(report);
});

// Closing line value — see clv.ts. `coverage` is the honest-portfolio
// context: only match_winner picks are ever coverable, and even those
// need a live odds quote to have existed at both analysis time and near
// kickoff, so `overall`/`byMarket`/`byModelProvider` speak only to the
// `coverage.closingCaptured` subset, never the full pick count.
analysisRouter.get("/clv", async (_req, res) => {
  const report = await computeClvReport();
  res.json(report);
});
