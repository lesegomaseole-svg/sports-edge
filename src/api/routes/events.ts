import { Router } from "express";
import { prisma } from "../../db/client";

export const eventsRouter = Router();

// Upcoming events across all tracked sports, soonest first.
eventsRouter.get("/", async (req, res) => {
  const sportKey = typeof req.query.sport === "string" ? req.query.sport : undefined;

  const events = await prisma.event.findMany({
    where: {
      completed: false,
      ...(sportKey ? { sport: { key: sportKey } } : {}),
    },
    include: { sport: true },
    orderBy: { commenceTime: "asc" },
    take: 100,
  });

  res.json(events);
});
