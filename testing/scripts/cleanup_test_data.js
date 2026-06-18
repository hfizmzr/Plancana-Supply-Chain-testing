/**
 * cleanup_test_data.js — Deletes all batches seeded by seed_test_data.js
 *
 * Usage:
 *   node cleanup_test_data.js
 *   node cleanup_test_data.js --dry-run    (preview what would be deleted)
 */

"use strict";

const { execSync } = require("child_process");
const path = require("path");

const DRY_RUN = process.argv.includes("--dry-run");

const PRISMA_DIR = path.join(__dirname, "..", "..", "application");

const SEED_NOTE_MARKER = "seed_test_data.js";

const script = `
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find all seeded batches
  const batches = await prisma.batch.findMany({
    where: { notes: { contains: '${SEED_NOTE_MARKER}' } },
    select: { batchId: true, status: true, crop: true, notes: true },
  });

  if (batches.length === 0) {
    console.log('No seeded test batches found.');
    process.exit(0);
  }

  console.log('\\nFound ' + batches.length + ' test batch(es) to delete:');
  batches.forEach(b => console.log('  ' + b.batchId + '  (' + b.crop + '  ' + b.status + ')'));

  if (${DRY_RUN}) {
    console.log('\\n[dry-run] Nothing deleted. Remove --dry-run to actually delete.');
    process.exit(0);
  }

  const batchIds = batches.map(b => b.batchId);

  // Delete child records first (in case cascade is not configured)
  const deletedDist = await prisma.distributionRecord.deleteMany({
    where: { batchId: { in: batchIds } },
  });
  const deletedProc = await prisma.processingRecord.deleteMany({
    where: { batchId: { in: batchIds } },
  });
  const deletedTransfers = await prisma.batchTransfer.deleteMany({
    where: { batchId: { in: batchIds } },
  });
  const deletedPricing = await prisma.pricingRecord.deleteMany({
    where: { batchId: { in: batchIds } },
  }).catch(() => ({ count: 0 }));

  // Delete the batches themselves
  const deleted = await prisma.batch.deleteMany({
    where: { batchId: { in: batchIds } },
  });

  console.log('\\nDeleted:');
  console.log('  ' + deleted.count + ' batch(es)');
  console.log('  ' + deletedProc.count + ' processing record(s)');
  console.log('  ' + deletedDist.count + ' distribution record(s)');
  console.log('  ' + deletedTransfers.count + ' batch transfer(s)');
  console.log('  ' + deletedPricing.count + ' pricing record(s)');
  console.log('\\nDone. Run node seed_test_data.js to create fresh test data.');
}

main()
  .catch(e => { console.error('Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
`;

// Run the inline Prisma script from the application directory
// (where node_modules/@prisma/client and .env exist)
const tmpFile = path.join(PRISMA_DIR, "_cleanup_tmp.js");
require("fs").writeFileSync(tmpFile, script);

console.log("Connecting to database via Prisma...");
console.log(DRY_RUN ? "(dry-run mode — nothing will be deleted)\n" : "");

try {
  execSync(`node _cleanup_tmp.js`, { cwd: PRISMA_DIR, stdio: "inherit" });
} finally {
  require("fs").unlinkSync(tmpFile);
}
