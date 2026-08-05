-- AlterTable
ALTER TABLE "Pick" ADD COLUMN "outcome" TEXT;
ALTER TABLE "Pick" ADD COLUMN "settledAt" DATETIME;

-- CreateTable
CREATE TABLE "MatchResult" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventId" INTEGER NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "finalScoreHome" INTEGER,
    "finalScoreAway" INTEGER,
    "htScoreHome" INTEGER,
    "htScoreAway" INTEGER,
    "homeCorners" INTEGER,
    "awayCorners" INTEGER,
    "totalCorners" INTEGER,
    "homeCards" INTEGER,
    "awayCards" INTEGER,
    "totalCards" INTEGER,
    "firstScoringTeam" TEXT,
    "lastScoringTeam" TEXT,
    "penaltyAwarded" BOOLEAN,
    "source" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MatchResult_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "MatchResult_eventId_key" ON "MatchResult"("eventId");
