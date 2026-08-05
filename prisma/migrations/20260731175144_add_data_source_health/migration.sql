-- CreateTable
CREATE TABLE "DataSourceHealth" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sourceId" TEXT NOT NULL,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "DataSourceHealth_sourceId_key" ON "DataSourceHealth"("sourceId");
