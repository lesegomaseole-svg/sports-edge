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
    "searchesPerformed" TEXT NOT NULL DEFAULT '[]',
    "runnerUp" TEXT,
    "searchesUsed" INTEGER NOT NULL DEFAULT 0,
    "degradedAnalysis" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Pick_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Pick" ("confidence", "createdAt", "eventId", "id", "marketType", "modelName", "modelProvider", "reasoning", "recommendation") SELECT "confidence", "createdAt", "eventId", "id", "marketType", "modelName", "modelProvider", "reasoning", "recommendation" FROM "Pick";
DROP TABLE "Pick";
ALTER TABLE "new_Pick" RENAME TO "Pick";
CREATE INDEX "Pick_eventId_createdAt_idx" ON "Pick"("eventId", "createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
