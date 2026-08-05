-- CreateTable
CREATE TABLE "LeagueBaseRate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sportId" INTEGER NOT NULL,
    "goalsPerMatch" REAL,
    "homeWinPct" REAL,
    "drawPct" REAL,
    "awayWinPct" REAL,
    "resultsSampleSize" INTEGER NOT NULL DEFAULT 0,
    "cornersPerMatch" REAL,
    "cardsPerMatch" REAL,
    "cornersCardsSampleSize" INTEGER NOT NULL DEFAULT 0,
    "computedAt" DATETIME NOT NULL,
    CONSTRAINT "LeagueBaseRate_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "Sport" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "LeagueBaseRate_sportId_key" ON "LeagueBaseRate"("sportId");
