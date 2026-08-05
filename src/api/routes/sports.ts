import { Router } from "express";
import { prisma } from "../../db/client";

export const sportsRouter = Router();

// Full catalog, with each sport's tracked markets — this is what the
// market-manager dashboard renders as the toggle list.
sportsRouter.get("/", async (_req, res) => {
  const sports = await prisma.sport.findMany({
    include: { trackedMarkets: true },
    orderBy: [{ group: "asc" }, { title: "asc" }],
  });
  res.json(sports);
});
