-- AlterTable
ALTER TABLE "Pick" ADD COLUMN "edgeCheckApplicable" BOOLEAN;
ALTER TABLE "Pick" ADD COLUMN "edgeCheckAt" DATETIME;
ALTER TABLE "Pick" ADD COLUMN "edgeCheckDevigedProbability" REAL;
ALTER TABLE "Pick" ADD COLUMN "edgeCheckEdge" REAL;
ALTER TABLE "Pick" ADD COLUMN "edgeCheckNote" TEXT;
ALTER TABLE "Pick" ADD COLUMN "edgeCheckPrice" REAL;
ALTER TABLE "Pick" ADD COLUMN "edgeCheckVetoReason" TEXT;
ALTER TABLE "Pick" ADD COLUMN "edgeCheckVetoed" BOOLEAN;
