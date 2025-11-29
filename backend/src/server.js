/**
 * backend/src/server.js
 * Safe bootstrap + telemetry disable + conditional route seeding
 */
process.env.GOOGLE_CLOUD_ENABLE_O11Y_TELEMETRY = "0";
process.env.OTEL_SDK_DISABLED = "true";
process.env.GCLOUD_DIAGNOSTICS_DISABLED = "true";
process.env.GOOGLE_CLOUD_LOGGING_ENABLE_TELEMETRY = "0";
process.env.GOOGLE_CLOUD_TRACE_ENABLE_TELEMETRY = "0";
process.env.GOOGLE_CLOUD_PROFILER_ENABLE = "0";

process.env.NODE_OPTIONS = [
  process.env.NODE_OPTIONS || "",
  "--disable-proto=throw",
].join(" ").trim();

import "dotenv/config";
import admin from "firebase-admin";
import fs from "fs";
import path from "path";
import "./index.js"; // <-- loads the Express + WS server

// Silence non-critical console logs in production deployments
function silenceConsoleInProd() {
  const shouldSilence =
    process.env.NODE_ENV === "production" ||
    process.env.DISABLE_CONSOLE_LOGS === "1";

  if (!shouldSilence) return;

  const noop = () => {};
  console.log = noop;
  console.info = noop;
  console.debug = noop;
  console.warn = noop;
  // Keep console.error for critical issues.
}
silenceConsoleInProd();

// ---------------------------------------------------------------------------
// 🔒 CONDITIONAL ROUTE SEEDING (runs once if Firestore empty)
// ---------------------------------------------------------------------------
async function maybeSeedRoutes() {
  try {
    const db = admin.firestore();
    const routesRef = db.collection("routes");
    const existing = await routesRef.limit(1).get();

    if (!existing.empty) {
      console.log("📍 Routes already exist in Firestore → skipping seed");
      return;
    }

    // Locate and parse seed file
    const seedPath = path.resolve(process.cwd(), "routes.json");
    if (!fs.existsSync(seedPath)) {
      console.warn("⚠️  routes.json not found — skipping seeding");
      return;
    }

    const raw = fs.readFileSync(seedPath, "utf8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data) || !data.length) {
      console.warn("⚠️  routes.json is empty — nothing to seed");
      return;
    }

    console.log(`📍 Seeding ${data.length} campus routes...`);
    const batch = db.batch();

    data.forEach((r) => {
      const id = String(r.id || r.route_id || r.routeName || Date.now());
      const docRef = routesRef.doc(id);
      batch.set(docRef, {
        route_name: r.route_name || r.routeName || id,
        directions: r.directions || r.Directions || {},
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    console.log("✅ Routes seeded successfully (first-time setup)");
  } catch (err) {
    console.error("❌ Route seed failed:", err);
  }
}

maybeSeedRoutes();
