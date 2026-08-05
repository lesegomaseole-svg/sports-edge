-- CreateTable
CREATE TABLE "GeminiQuotaUsage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "dailyWindowStart" DATETIME NOT NULL,
    "dailyRequests" INTEGER NOT NULL DEFAULT 0,
    "monthlyWindowStart" DATETIME NOT NULL,
    "monthlySearches" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);
