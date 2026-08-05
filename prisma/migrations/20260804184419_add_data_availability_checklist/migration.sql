-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Pick" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "eventId" INTEGER NOT NULL,
    "marketType" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "confidence" REAL NOT NULL,
    "reasoning" TEXT NOT NULL,
    "modelProvider" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "keyFactors" TEXT NOT NULL DEFAULT '[]',
    "dataGaps" TEXT NOT NULL DEFAULT '[]',
    "dataAvailability" TEXT NOT NULL DEFAULT '{}',
    "searchesPerformed" TEXT NOT NULL DEFAULT '[]',
    "runnerUp" TEXT,
    "searchesUsed" INTEGER NOT NULL DEFAULT 0,
    "degradedAnalysis" BOOLEAN NOT NULL DEFAULT false,
    "discrepancies" TEXT NOT NULL DEFAULT '[]',
    "outcome" TEXT,
    "settledAt" DATETIME,
    "critiqued" BOOLEAN NOT NULL DEFAULT false,
    "preCritiqueRecommendation" TEXT,
    "preCritiqueConfidence" REAL,
    "preCritiqueReasoning" TEXT,
    "critiqueNotes" TEXT,
    "critiqueAttempted" BOOLEAN NOT NULL DEFAULT false,
    "critiqueAttemptFailed" BOOLEAN NOT NULL DEFAULT false,
    "critiqueError" TEXT,
    "oddsAtPick" REAL,
    "closingOdds" REAL,
    "clvDelta" REAL,
    "clvCaptured" BOOLEAN NOT NULL DEFAULT false,
    "clvCaptureSource" TEXT,
    CONSTRAINT "Pick_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Pick" ("closingOdds", "clvCaptureSource", "clvCaptured", "clvDelta", "confidence", "createdAt", "critiqueAttemptFailed", "critiqueAttempted", "critiqueError", "critiqueNotes", "critiqued", "dataGaps", "degradedAnalysis", "discrepancies", "eventId", "id", "keyFactors", "marketType", "modelName", "modelProvider", "oddsAtPick", "outcome", "preCritiqueConfidence", "preCritiqueReasoning", "preCritiqueRecommendation", "reasoning", "recommendation", "runnerUp", "searchesPerformed", "searchesUsed", "settledAt") SELECT "closingOdds", "clvCaptureSource", "clvCaptured", "clvDelta", "confidence", "createdAt", "critiqueAttemptFailed", "critiqueAttempted", "critiqueError", "critiqueNotes", "critiqued", "dataGaps", "degradedAnalysis", "discrepancies", "eventId", "id", "keyFactors", "marketType", "modelName", "modelProvider", "oddsAtPick", "outcome", "preCritiqueConfidence", "preCritiqueReasoning", "preCritiqueRecommendation", "reasoning", "recommendation", "runnerUp", "searchesPerformed", "searchesUsed", "settledAt" FROM "Pick";
DROP TABLE "Pick";
ALTER TABLE "new_Pick" RENAME TO "Pick";
CREATE UNIQUE INDEX "Pick_eventId_key" ON "Pick"("eventId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
