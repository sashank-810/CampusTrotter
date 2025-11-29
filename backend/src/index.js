/**
 * backend/src/index.js
 * WebSocket auth-first + Direction-aware broadcast + rock-solid CORS for localhost
 */
import express from "express";
import "dotenv/config";  // or: import dotenv from "dotenv"; dotenv.config();
import admin from "firebase-admin";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import { WebSocketServer } from "ws";
import * as querystring from "querystring";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { authenticate, requireAdmin } from "./middleware/auth.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import vehicleRoutes from "./routes/vehicle.js";
import routeRoutes from "./routes/route.js";
import feedbackRoutes from "./routes/feedback.js";
import alertsRoutes from "./routes/alerts.js";
import driverRoutes from "./routes/driver.js";
import stopsRoutes from "./routes/stops.js";
import plannerRoutes from "./routes/planner.js";
import liveRoutes from "./routes/live.js";
import assignmentRoutes from "./routes/assignment.js";
import { runReservationReaper } from "./services/reservationReaper.js";

// 🔹 New imports
import reportsRoutes from "./routes/reports.js";
import { runTripSynthesizer } from "./services/tripSynthesizer.js";
import etaRoutes from "./routes/eta.js";
import driverAssignmentRoutes from "./routes/driverAssignment.js";
import shiftsRoutes from "./routes/shifts.js";
import pushNotificationRoutes from "./routes/pushNotifications.js";

// 🔹 New services
import { startETANotificationService } from "./services/etaNotificationService.js";

// 🔹 Rate limiting middleware (individual limiters used in auth.js)
import { blockCheckMiddleware } from "./middleware/rateLimiter.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ----------------------------------------------------------------------------
// 🔐 JWT secret bootstrap (FIXES hardcoded weak fallback)
// ----------------------------------------------------------------------------
function ensureJwtSecret() {
  const existing = process.env.JWT_SECRET?.trim();

  // If already provided, use it.
  if (existing) return existing;

  const isProd = (process.env.NODE_ENV || "").toLowerCase() === "production";
  const usingEmulator = !!process.env.FIRESTORE_EMULATOR_HOST?.trim();

  if (isProd) {
    console.error(
      "❌ FATAL: JWT_SECRET is missing in production.\n" +
        "Set a strong secret in your environment. Refusing to start."
    );
    process.exit(1);
  }

  // Dev / emulator convenience: generate strong random secret per boot
  const generated = crypto.randomBytes(48).toString("hex");
  process.env.JWT_SECRET = generated;

  console.warn(
    "⚠️  JWT_SECRET was not set. Generated a strong random secret for this dev session.\n" +
      "Tokens will become invalid after restart.\n" +
      (usingEmulator
        ? "✅ Firestore emulator detected; this is expected for local dev."
        : "ℹ️  Consider adding JWT_SECRET to .env for stable local tokens.")
  );

  return generated;
}

// Ensure secret exists early so all modules/middleware see it.
// (Even if they do process.env.JWT_SECRET || "secret", they’ll now pick this.)
const JWT_SECRET = ensureJwtSecret();

// ----------------------------------------------------------------------------
// Firebase init
// ----------------------------------------------------------------------------
function initFirebase() {
  if (admin.apps.length) return admin.app();

  const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST?.trim();
  const projectId =
    process.env.FIREBASE_PROJECT_ID?.trim() || "";

  if (emulatorHost) {
    console.log(`🔥 Using Firestore Emulator: ${emulatorHost}`);
    admin.initializeApp({ projectId });
    const dbEmu = admin.firestore();
    dbEmu.settings({ host: emulatorHost, ssl: false });
    return admin.app();
  }

  const servicePath = path.resolve(
    process.cwd(),
    process.env.GOOGLE_APPLICATION_CREDENTIALS || ""
  );
  if (!fs.existsSync(servicePath)) {
    console.error("❌ Missing service account JSON:", servicePath);
    process.exit(1);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(servicePath, "utf8"));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id || projectId,
  });
  console.log(
    `☁️ Firebase initialized (projectId=${serviceAccount.project_id})`
  );
  return admin.app();
}
initFirebase();
const db = admin.firestore();

// ----------------------------------------------------------------------------
// Express app
// ----------------------------------------------------------------------------
const app = express();
app.set("trust proxy", true);

// ----------------------------------------------------------------------------
// 🔒 Secure CORS configuration
// ----------------------------------------------------------------------------

// Default allowed origins (your current setup)
const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3001", // Admin portal
  "http://localhost:8081", // User app
  "http://<UNIQUE_S3_BUCKET>.s3-website.<REGION>.amazonaws.com",
  "https://<UNIQUE_S3_BUCKET>.s3-website.<REGION>.amazonaws.com",
];

// Optional extra origins via env: CORS_ORIGINS="http://foo.com,https://bar.com"
const extraOrigins =
  process.env.CORS_ORIGINS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) || [];

const ALLOWED_ORIGINS = new Set([...DEFAULT_ALLOWED_ORIGINS, ...extraOrigins]);

const corsOptions = {
  origin(origin, callback) {
    // Non-browser / same-origin / curl / Postman → no Origin header
    if (!origin) {
      if (process.env.DEBUG_CORS === "1") {
        console.log("🌐 CORS: no Origin header (likely backend/script)");
      }
      return callback(null, true);
    }

    if (ALLOWED_ORIGINS.has(origin)) {
      if (process.env.DEBUG_CORS === "1") {
        console.log(`✅ CORS allowed: ${origin}`);
      }
      return callback(null, true);
    }

    // Block anything else (fixes the audit complaint)
    console.warn(`🚫 CORS blocked origin: ${origin}`);
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "ngrok-skip-browser-warning",
    "x-user-role",
  ],
  optionsSuccessStatus: 204,
};

// Apply CORS for all routes
app.use(cors(corsOptions));

// ❌ REMOVED: app.options("*", cors(corsOptions));  // this caused path-to-regexp error

// Generic OPTIONS handler (no wildcard path, so no path-to-regexp crash)
// CORS headers are already set by cors() above; this just ends the request.
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Keep ngrok header helper (harmless)
app.use((req, res, next) => {
  if (req.headers["ngrok-skip-browser-warning"] === undefined)
    req.headers["ngrok-skip-browser-warning"] = "true";
  res.setHeader("ngrok-skip-browser-warning", "true");
  next();
});

app.use(express.json({ limit: "1mb" }));

// 🔒 Block IPs flagged for suspicious activity
app.use(blockCheckMiddleware);

// Request logger
app.use((req, res, next) => {
  const start = Date.now();
  console.log(`➡️  ${req.method} ${req.originalUrl}`);
  res.on("finish", () =>
    console.log(
      `⬅️  ${req.method} ${req.originalUrl} -> ${res.statusCode} (${
        Date.now() - start
      }ms)`
    )
  );
  next();
});

// ---------------- Routes that don't need wss ----------------
app.use("/auth", authRoutes(db));
app.use("/vehicles", vehicleRoutes(db));
app.use("/vehicle", authenticate, vehicleRoutes(db));

/**
 * ✅ Reservation summary for admin DemandLayer
 *
 * GET /routes/:routeId/reservations/summary?direction=to|fro
 */
app.get("/routes/:routeId/reservations/summary", async (req, res) => {
  try {
    const { routeId } = req.params;
    const directionRaw = req.query.direction;
    const direction =
      directionRaw === "to" || directionRaw === "fro"
        ? directionRaw
        : undefined;

    if (!routeId) {
      return res.status(400).json({ error: "routeId is required" });
    }

    let query = db.collection("reservations").where("route_id", "==", routeId);

    if (direction) {
      query = query.where("direction", "==", direction);
    }

    const ACTIVE_STATUSES = new Set([
      "created",
      "waiting",
      "assigned",
      "accepted",
      "enroute",
      "pending",
      "queued",
    ]);

    const SNAP_LIMIT = 1000;
    const snap = await query.limit(SNAP_LIMIT).get();

    const waitingBySeq = {};
    let totalWaiting = 0;

    snap.forEach((doc) => {
      const r = doc.data() || {};
      const status = (r.status || "").toString().toLowerCase();

      if (status && !ACTIVE_STATUSES.has(status)) {
        return;
      }

      const seqRaw =
        r.sequence ??
        r.source_sequence ??
        r.dest_sequence ??
        r.stop_sequence ??
        null;

      const seq = Number(seqRaw);
      if (!Number.isFinite(seq)) return;

      const countRaw =
        r.waiting_count ??
        r.count ??
        r.party_size ??
        r.pax ??
        r.riders ??
        1;

      const count = Number.isFinite(Number(countRaw))
        ? Number(countRaw)
        : 1;

      if (count <= 0) return;

      waitingBySeq[seq] = (waitingBySeq[seq] || 0) + count;
      totalWaiting += count;
    });

    const stops = Object.keys(waitingBySeq)
      .map((k) => ({
        sequence: Number(k),
        waiting_count: waitingBySeq[k],
      }))
      .sort((a, b) => a.sequence - b.sequence);

    return res.json({
      route_id: routeId,
      direction: direction ?? null,
      total_waiting: totalWaiting,
      stops,
    });
  } catch (err) {
    console.error(
      "❌ /routes/:routeId/reservations/summary error",
      err
    );
    return res
      .status(500)
      .json({ error: "Failed to compute reservation summary" });
  }
});

app.use("/routes", routeRoutes(db));
app.use("/stops", routeRoutes(db));
app.use("/feedback", authenticate, feedbackRoutes(db));

app.get("/admin/analytics", async (req, res) => {
  try {
    console.log("📊 Computing admin analytics…");
    const [driversSnap, usersSnap] = await Promise.all([
      db.collection("drivers").get(),
      db.collection("users").get(),
    ]);
    res.json({
      peakUsage: "Not computed yet",
      activeDrivers: driversSnap.size,
      totalUsers: usersSnap.size,
    });
  } catch (err) {
    console.error("❌ /admin/analytics error:", err);
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

app.use("/admin", authenticate, requireAdmin, adminRoutes(db));
app.use("/assignments", assignmentRoutes(db));

// 🔹 Mount new reporting routes
app.use("/reports", reportsRoutes(db));

// 🔹 Mount ETA routes
app.use("/eta", etaRoutes(db)); // ⬅️ NEW

console.log("🛠️ Routes loaded successfully.");

// ----------------------------------------------------------------------------
// HTTP + WebSocket Server
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 5001;
const server = app.listen(PORT, () =>
  console.log(`🚀 Backend running on http://localhost:${PORT}`)
);

const wss = new WebSocketServer({ noServer: true });

// 🔗 Make wss globally visible for broadcast helpers in other route modules
globalThis.__transvahan_wss__ = wss;

// ----------------------------------------------------------------------------
// 📡 Scalable WebSocket Broadcast Manager
// ----------------------------------------------------------------------------
/**
 * Broadcast manager for handling concurrent WebSocket clients efficiently.
 * - Uses async iteration to prevent blocking on slow clients
 * - Implements message deduplication within broadcast windows
 * - Adds backpressure handling to prevent memory issues
 */
class BroadcastManager {
  constructor(wss) {
    this.wss = wss;
    this.messageQueue = new Map(); // Deduplication: type+id -> latest message
    this.isBroadcasting = false;
    this.MAX_QUEUE_SIZE = 1000;
  }

  /**
   * Queue a message for broadcast. Messages with same type+id are deduplicated.
   */
  queueBroadcast(type, data, dedupeKey = null) {
    const key = dedupeKey || `${type}:${data?.id || data?.vehicle_id || "default"}`;

    // Prevent unbounded queue growth
    if (this.messageQueue.size >= this.MAX_QUEUE_SIZE) {
      // Remove oldest entries (first 100)
      const keysToRemove = Array.from(this.messageQueue.keys()).slice(0, 100);
      keysToRemove.forEach((k) => this.messageQueue.delete(k));
    }

    this.messageQueue.set(key, { type, data, timestamp: Date.now() });
  }

  /**
   * Broadcast all queued messages to connected clients.
   * Uses non-blocking sends with error handling per client.
   */
  async flushBroadcasts() {
    if (this.isBroadcasting || this.messageQueue.size === 0) return;

    this.isBroadcasting = true;
    const messages = Array.from(this.messageQueue.values());
    this.messageQueue.clear();

    const clients = Array.from(this.wss.clients || []);

    // Broadcast to all clients concurrently but with error isolation
    await Promise.allSettled(
      clients.map(async (ws) => {
        if (ws.readyState !== ws.OPEN) return;

        for (const msg of messages) {
          try {
            const payload = JSON.stringify({ type: msg.type, data: msg.data });
            // Use a promise wrapper for send to handle backpressure
            await new Promise((resolve, reject) => {
              ws.send(payload, (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
          } catch {
            // Client disconnected or slow - skip without blocking others
          }
        }
      })
    );

    this.isBroadcasting = false;
  }

  /**
   * Immediate broadcast (for critical real-time updates).
   * Still uses non-blocking sends.
   */
  broadcastImmediate(type, data) {
    const payload = JSON.stringify({ type, data });
    const clients = Array.from(this.wss.clients || []);

    clients.forEach((ws) => {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(payload, () => {}); // Fire-and-forget with callback
        } catch {
          // Ignore send errors
        }
      }
    });
  }
}

const broadcastManager = new BroadcastManager(wss);
globalThis.__transvahan_broadcast_manager__ = broadcastManager;

// Flush queued broadcasts every 500ms (more responsive than 1.5s)
setInterval(() => broadcastManager.flushBroadcasts(), 500);

// -------------- WebSocket upgrade & broadcast ------------------
server.on("upgrade", (req, socket, head) => {
  try {
    const url = req.url || "";
    let rawRole = "";
    const pathMatch = (url || "").match(/^\/ws\/([a-z]+)/i);
    if (pathMatch) rawRole = pathMatch[1];
    if (!rawRole && url.includes("?")) {
      const parsed = querystring.parse(url.split("?")[1]);
      rawRole = parsed.role
        ? String(parsed.role).toLowerCase().trim()
        : "";
    }
    const headerRaw = req.headers["x-user-role"]
      ? String(req.headers["x-user-role"]).toLowerCase().trim()
      : "";
    const candidate = rawRole || headerRaw || "";
    req.roleParam = ["user", "driver", "admin"].includes(candidate)
      ? candidate
      : "user";
  } catch {
    req.roleParam = "user";
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  let roleGuess = req.roleParam || "user";
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.socket.remoteAddress ||
    "unknown";
  let broadcastInterval = null;
  let authTimer = null;
  let authenticated = false;
  const DEMAND_TTL_MS = 10 * 60 * 1000; // Match driver.js demand signal expiration (10 minutes)

  const startBroadcast = () => {
    if (broadcastInterval) return;
    ws.userRole = roleGuess;
    try {
      ws.send(
        JSON.stringify({
          type: "welcome",
          data: {
            role: ws.userRole,
            ip: clientIp,
            time: new Date().toISOString(),
          },
        })
      );
    } catch {}
    broadcastInterval = setInterval(async () => {
      try {
        const snapshot = await db.collection("vehicles").get();
        const now = Date.now();
        snapshot.forEach((doc) => {
          const v = doc.data();
          const demandTs = Number(v.demand_ts || 0);
          const demandActive =
            !!v.demand_high &&
            demandTs &&
            now - demandTs < DEMAND_TTL_MS;
          const shaped = {
            id: doc.id,
            vehicle_id: v.plateNo ?? v.vehicle_id ?? doc.id,
            route_id: v.currentRoute ?? "unknown",
            direction: v.direction ?? "to",
            lat: v.location?.lat ?? v.location?.latitude ?? 0,
            lng: v.location?.lng ?? v.location?.longitude ?? 0,
            occupancy: v.occupancy ?? 0,
            capacity: v.capacity ?? 4,
            vacant: (v.capacity ?? 4) - (v.occupancy ?? 0),
            status: v.status ?? "inactive",
            updated_at: v.location?.timestamp
              ? new Date(v.location.timestamp).toISOString()
              : new Date().toISOString(),
            demand_high: demandActive,
          };
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "vehicle", data: shaped }));
          }
        });
      } catch (err) {
        console.error("WebSocket broadcast error:", err);
      }
    }, 1500);
  };

  authTimer = setTimeout(() => {
    if (!authenticated) startBroadcast();
  }, 4000);

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth") {
        clearTimeout(authTimer);
        const token = msg.token || msg.jwt || msg.authToken;
        if (!token) return startBroadcast();
        try {
          // ✅ Use hardened secret (no weak fallback)
          const decoded = jwt.verify(token, JWT_SECRET);

          const tokenRole = (
            decoded.role || decoded.userRole || decoded.type || ""
          )
            .toString()
            .toLowerCase()
            .trim();
          if (["driver", "user", "admin"].includes(tokenRole))
            roleGuess = tokenRole;
          ws.user = decoded;
          ws.userRole = roleGuess;
          authenticated = true;
          ws.send(
            JSON.stringify({
              type: "auth_ack",
              success: true,
              role: ws.userRole,
            })
          );
        } catch {
          ws.send(
            JSON.stringify({
              type: "auth_ack",
              success: false,
              error: "invalid_token",
            })
          );
        } finally {
          startBroadcast();
        }
      } else if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", time: Date.now() }));
      }
    } catch {}
  });

  ws.on("close", () => {
    if (authTimer) clearTimeout(authTimer);
    if (broadcastInterval) clearInterval(broadcastInterval);
  });
});

// Routes needing wss
app.use("/driver", driverRoutes(db, wss));
app.use("/alerts", alertsRoutes(db, wss));
app.use("/stops", stopsRoutes());
app.use("/planner", plannerRoutes());
app.use("/live", liveRoutes(db, wss));
app.use("/driver", driverAssignmentRoutes(db));

// 🔹 New routes: Shifts & Push Notifications
app.use("/shifts", shiftsRoutes(db));
app.use("/notifications", pushNotificationRoutes(db));

app.get("/health", async (_req, res) => {
  try {
    await db.collection("users").limit(1).get();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 🔹 Launch background trip summarizer
setInterval(() => runTripSynthesizer(db), 30000);
console.log("🕒 TripSynth initialized (30s interval)");

// 🔹 Launch reservation reaper (detect missed reservations)
setInterval(() => runReservationReaper(db), 5000);
console.log("🕒 ReservationReaper initialized (5s interval)");

// 🔹 Launch ETA notification service (check every 30 seconds)
startETANotificationService(db, 30000);
console.log("🔔 ETA Notification Service initialized (30s interval)");

export { db, wss };