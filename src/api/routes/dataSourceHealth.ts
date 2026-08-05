/**
 * Inspect ingestion-time data source reliability — see
 * src/lib/dataSourceHealth.ts for how these rows get written.
 */
import { Router } from "express";
import { prisma } from "../../db/client";

export const dataSourceHealthRouter = Router();

dataSourceHealthRouter.get("/health", async (_req, res) => {
  const rows = await prisma.dataSourceHealth.findMany({ orderBy: { sourceId: "asc" } });
  res.json(rows);
});
