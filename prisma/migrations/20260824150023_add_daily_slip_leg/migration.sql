-- CreateTable
CREATE TABLE "DailySlipLeg" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runDate" TEXT NOT NULL,
    "eventId" INTEGER NOT NULL,
    "marketType" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "baselineProbability" REAL NOT NULL,
    "adjustedProbability" REAL NOT NULL,
    "devigedMarketProbability" REAL,
    "price" REAL,
    "edge" REAL,
    "veto" BOOLEAN NOT NULL,
    "vetoReason" TEXT,
    "passedEvGate" BOOLEAN NOT NULL,
    "reasoning" TEXT NOT NULL,
    "dataGaps" TEXT NOT NULL DEFAULT '[]',
    "includedInCombo" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT,
    "settledAt" DATETIME,
    "closingOdds" REAL,
    "clvDelta" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DailySlipLeg_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DailySlipLeg_runDate_idx" ON "DailySlipLeg"("runDate");

-- CreateIndex
CREATE INDEX "DailySlipLeg_eventId_idx" ON "DailySlipLeg"("eventId");
