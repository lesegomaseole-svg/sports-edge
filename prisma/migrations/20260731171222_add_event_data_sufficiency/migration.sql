-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Event" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "externalId" TEXT NOT NULL,
    "sportId" INTEGER NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "commenceTime" DATETIME NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "hasSufficientData" BOOLEAN NOT NULL DEFAULT false,
    "dataScore" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Event_sportId_fkey" FOREIGN KEY ("sportId") REFERENCES "Sport" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Event" ("awayTeam", "commenceTime", "completed", "createdAt", "externalId", "homeTeam", "id", "sportId", "updatedAt") SELECT "awayTeam", "commenceTime", "completed", "createdAt", "externalId", "homeTeam", "id", "sportId", "updatedAt" FROM "Event";
DROP TABLE "Event";
ALTER TABLE "new_Event" RENAME TO "Event";
CREATE UNIQUE INDEX "Event_externalId_key" ON "Event"("externalId");
CREATE INDEX "Event_sportId_commenceTime_idx" ON "Event"("sportId", "commenceTime");
CREATE INDEX "Event_dataScore_idx" ON "Event"("dataScore");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
