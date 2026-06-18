/**
 * seed_test_data.js — Plancana F08 Test Data Seeder
 *
 * Creates two batches via the real API and writes their IDs to batch_ids.json
 * so the Selenium tests can run fully automatically without any manual setup.
 *
 *   INCOMPLETE batch → Farmer only (status: REGISTERED)
 *   COMPLETE batch   → Full chain: Farmer → Processor → Distributor → Retailer
 *                      (status: IN_RETAIL)
 *
 * Usage:
 *   node seed_test_data.js
 *   node seed_test_data.js --api http://localhost:3000   (override API URL)
 *
 * Requirements:
 *   - Node.js 18+  (uses built-in fetch — no npm install needed)
 *   - Backend running at http://localhost:3000
 *   - Blockchain network running  (docker compose ps)
 *   - Database seeded with default accounts  (npm run seed inside application/)
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ─── Configuration ───────────────────────────────────────────
const API_URL = (() => {
  const i = process.argv.indexOf("--api");
  return i !== -1 ? process.argv[i + 1]
       : process.env.PLANCANA_API_URL || "http://localhost:3000";
})();

const OUT_FILE = path.join(__dirname, "batch_ids.json");

const ACCOUNTS = {
  FARMER:      { email: "ahmad@farm.com",            password: "farmer123"       },
  PROCESSOR:   { email: "mill@processor.com",        password: "processor123"    },
  DISTRIBUTOR: { email: "logistics@distributor.com", password: "distributor123"  },
  RETAILER:    { email: "store@retail.com",          password: "retailer123"     },
};
// ─────────────────────────────────────────────────────────────


// ─── HTTP helper ─────────────────────────────────────────────
async function api(method, urlPath, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data;
  try { data = await res.json(); }
  catch { throw new Error(`${method} ${urlPath} → ${res.status}: non-JSON response`); }

  if (!res.ok) {
    const msg = data?.error || data?.message || JSON.stringify(data);
    throw new Error(`${method} ${urlPath} → ${res.status}: ${msg}`);
  }
  return data;
}
// ─────────────────────────────────────────────────────────────


// ─── Logging helpers ─────────────────────────────────────────
const ok  = (msg) => console.log(`  ✓ ${msg}`);
const log = (msg) => console.log(`    ${msg}`);
const sep = (msg) => console.log(`\n${"─".repeat(52)}\n  ${msg}\n${"─".repeat(52)}`);
// ─────────────────────────────────────────────────────────────


async function login(role) {
  const { email, password } = ACCOUNTS[role];
  log(`Logging in as ${role} (${email})...`);
  const data = await api("POST", "/api/auth/login", { email, password });
  if (!data.success) throw new Error(`Login failed for ${role}: ${data.error}`);
  ok(`Authenticated as ${role}`);
  return { token: data.token, user: data.user };
}


// ─── INCOMPLETE BATCH ─────────────────────────────────────────
// Only the Farmer stage — status stays REGISTERED
// ─────────────────────────────────────────────────────────────
async function createIncompleteBatch() {
  sep("Creating INCOMPLETE batch  [Farmer only → REGISTERED]");

  const { token, user } = await login("FARMER");

  const data = await api("POST", "/api/batch/create", {
    farmer:       user.username,
    crop:         "Rice",
    cropType:     "grain",
    quantity:     200,
    unit:         "kg",
    location:     "Kedah, Malaysia",
    harvestDate:  new Date().toISOString(),
    qualityGrade: "B",
    pricePerUnit: 2.00,
    currency:     "MYR",
    notes:        "Seeded by seed_test_data.js — incomplete batch for testing",
  }, token);

  ok(`Batch created: ${data.batchId}  (status: REGISTERED)`);
  return data.batchId;
}


// ─── COMPLETE BATCH ───────────────────────────────────────────
// Full supply chain: Farmer → Processor → Distributor → Retailer
// Final status: IN_RETAIL
// ─────────────────────────────────────────────────────────────
async function createCompleteBatch() {
  sep("Creating COMPLETE batch  [Full supply chain → IN_RETAIL]");

  // ── 1. Farmer creates batch ──────────────────────────────
  const { token: farmerToken, user: farmerUser } = await login("FARMER");

  const createData = await api("POST", "/api/batch/create", {
    farmer:       farmerUser.username,
    crop:         "Palm Oil",
    cropType:     "plantation",
    quantity:     1000,
    unit:         "kg",
    location:     "Perak, Malaysia",
    harvestDate:  new Date().toISOString(),
    qualityGrade: "A",
    pricePerUnit: 3.80,
    currency:     "MYR",
    notes:        "Seeded by seed_test_data.js — complete batch for testing",
  }, farmerToken);

  const batchId = createData.batchId;
  ok(`[1/5] Farmer created batch: ${batchId}`);

  // ── 2. Processor starts processing ──────────────────────
  const { token: processorToken } = await login("PROCESSOR");

  await api("POST", `/api/processor/process/${batchId}`, {
    processType:        "initial_processing",
    processingLocation: "Ipoh Processing Plant, Perak",
    inputQuantity:      1000,
    outputQuantity:     950,
    notes:              "Automated seed — processing started",
  }, processorToken);
  ok(`[2/5] Processor started processing  (status: PROCESSING)`);

  // ── 3. Processor completes processing ───────────────────
  await api("PUT", `/api/processor/complete/${batchId}`, {
    qualityGrade:    "A",
    outputQuantity:  950,
    completionNotes: "Automated seed — processing complete",
  }, processorToken);
  ok(`[3/5] Processor completed  (status: PROCESSED)`);

  // ── 4. Distributor receives batch ───────────────────────
  const { token: distributorToken } = await login("DISTRIBUTOR");

  await api("POST", `/api/distributor/receive/${batchId}`, {
    transferLocation: "Shah Alam Distribution Hub, Selangor",
    notes:            "Automated seed — distributor received",
  }, distributorToken);
  ok(`[4/5] Distributor received  (status: IN_DISTRIBUTION)`);

  // Transfer to retailer (accepts email as toRetailerId)
  await api("POST", `/api/distributor/transfer-to-retailer/${batchId}`, {
    toRetailerId:     ACCOUNTS.RETAILER.email,
    transferLocation: "Shah Alam, Selangor",
    notes:            "Automated seed — transferred to retailer",
  }, distributorToken);
  ok(`[4/5] Transferred to retailer  (status: RETAIL_READY)`);

  // ── 5. Retailer receives batch ──────────────────────────
  const { token: retailerToken } = await login("RETAILER");

  await api("POST", `/api/retailer/receive/${batchId}`, {
    receiveLocation: "Plancana Retail Store, Kuala Lumpur",
    notes:           "Automated seed — retailer received",
  }, retailerToken);
  ok(`[5/5] Retailer received  (status: IN_RETAIL)`);

  return batchId;
}


// ─── Main ─────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(54));
  console.log("  Plancana F08 — Test Data Seeder");
  console.log(`  API: ${API_URL}`);
  console.log("═".repeat(54));

  // Require Node 18+ for built-in fetch
  const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
  if (nodeMajor < 18) {
    console.error(`\nERROR: Node.js 18+ required (you have ${process.version}).`);
    console.error("       Use: nvm install 18 && nvm use 18");
    process.exit(1);
  }

  // Quick connectivity check
  try {
    await fetch(`${API_URL}/api/auth/login`, { method: "OPTIONS" }).catch(() => {
      throw new Error("No response from server");
    });
  } catch {
    console.error(`\nERROR: Cannot reach ${API_URL}`);
    console.error("       Make sure the backend is running:  cd application && npm start");
    process.exit(1);
  }

  try {
    const incompleteBatchId = await createIncompleteBatch();
    const completeBatchId   = await createCompleteBatch();

    const output = {
      VALID_BATCH_ID:      completeBatchId,
      INCOMPLETE_BATCH_ID: incompleteBatchId,
      seeded_at:           new Date().toISOString(),
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

    console.log("\n" + "═".repeat(54));
    console.log("  ✓ Seed complete!");
    console.log(`  VALID_BATCH_ID:      ${completeBatchId}`);
    console.log(`  INCOMPLETE_BATCH_ID: ${incompleteBatchId}`);
    console.log("  Saved to: batch_ids.json");
    console.log("\n  Now run:  .\\run_f08.ps1 --headed --skip-seed");
    console.log("═".repeat(54) + "\n");

  } catch (err) {
    console.error(`\n✗ Seed failed at step: ${err.message}`);
    console.error("\nTroubleshooting:");
    console.error("  1. Is the backend running?   cd application && npm start");
    console.error("  2. Is the blockchain up?     docker compose ps");
    console.error("  3. Is the DB seeded?         cd application && npx prisma db seed");
    process.exit(1);
  }
}

main();
