// backend/src/routes/route.js
import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import { getRoutePolylineForStops } from "../utils/googleDirections.js";

/**
 * Small helper to broadcast over WebSocket if the backend
 * exposes `wss` as `globalThis.__transvahan_wss__`.
 *
 * In your server startup, add:
 *   globalThis.__transvahan_wss__ = wss;
 */
function broadcastWS(type, data) {
  try {
    const wss = globalThis.__transvahan_wss__;
    if (!wss || !wss.clients) return;
    const payload = JSON.stringify({ type, data });
    wss.clients.forEach((ws) => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

function genId() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

function normalizeDirections(directions = {}) {
  const to = Array.isArray(directions.to) ? directions.to : [];
  let fro = Array.isArray(directions.fro) ? directions.fro : [];

  const norm = (arr) =>
    arr.map((s, i) => ({
      stop_id: s.stop_id || s.id || Math.random().toString(36).slice(2),
      stop_name: s.stop_name || s.name || `Stop ${i + 1}`,
      location: {
        latitude: Number(s.location?.latitude ?? s.lat ?? 0),
        longitude: Number(s.location?.longitude ?? s.lng ?? s.lon ?? 0),
      },
      sequence: Number.isFinite(s.sequence) ? Number(s.sequence) : i,
      ...Object.fromEntries(
        Object.entries(s || {}).filter(
          ([k]) =>
            ![
              "stop_id",
              "id",
              "stop_name",
              "name",
              "location",
              "lat",
              "lon",
              "lng",
              "sequence",
            ].includes(k)
        )
      ),
    }));

  const toN = norm(to);
  let froN = norm(fro);

  if (!fro.length) {
    froN = [...toN].reverse().map((s, i) => ({ ...s, sequence: i }));
  } else {
    froN = froN.map((s, i) => ({
      ...s,
      sequence: Number.isFinite(s.sequence) ? Number(s.sequence) : i,
    }));
  }
  return { to: toN, fro: froN };
}

function normalizeTimeStr(raw) {
  if (!raw && raw !== 0) return null;
  const m = String(raw).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${h.toString().padStart(2, "0")}:${min
    .toString()
    .padStart(2, "0")}`;
}

function normalizeSchedule(schedule = []) {
  const rows = Array.isArray(schedule) ? schedule : [];
  const seen = new Set();
  return rows
    .map((r, idx) => {
      const dirRaw = (r.direction || r.dir || "to").toString().toLowerCase();
      const direction = dirRaw === "fro" ? "fro" : "to";
      const daysArr = Array.isArray(r.days)
        ? r.days.map((d) => String(d || "").trim()).filter(Boolean)
        : [];
      const startTime =
        normalizeTimeStr(
          r.startTime ||
            r.start_time ||
            r.departTime ||
            r.depart_time ||
            r.time
        ) || null;
      const endTime =
        normalizeTimeStr(
          r.endTime || r.end_time || r.arrivalTime || r.arrival_time
        ) || null;
      const id =
        r.id ||
        r.schedule_id ||
        r.trip_id ||
        r.tripNumber ||
        `sch_${idx}_${genId().slice(0, 6)}`;
      if (!startTime) return null;

      return {
        id: String(id),
        direction,
        startTime,
        endTime,
        note: r.note || r.remark || r.label || "",
        sequence: Number.isFinite(r.sequence) ? Number(r.sequence) : idx,
        ...(daysArr.length ? { days: daysArr } : {}),
      };
    })
    .filter(Boolean)
    .filter((row) => {
      if (seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    })
    .sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === "to" ? -1 : 1;
      return a.startTime.localeCompare(b.startTime);
    })
    .map((row, idx) => ({
      ...row,
      sequence: Number.isFinite(row.sequence) ? row.sequence : idx,
    }));
}

/**
 * Filter out schedules that have already passed for today.
 * A schedule is considered "passed" if its endTime (or startTime if no endTime)
 * is before the current time.
 */
function filterActiveSchedules(schedules) {
  const now = new Date();
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTimeMinutes = currentHours * 60 + currentMinutes;

  return schedules.filter((s) => {
    // Use endTime if available, otherwise use startTime
    const timeToCompare = s.endTime || s.startTime;
    if (!timeToCompare) return true; // Keep if no time set

    const [hours, minutes] = timeToCompare.split(":").map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return true;

    const scheduleTimeMinutes = hours * 60 + minutes;

    // Keep schedule if its time hasn't passed yet
    return scheduleTimeMinutes > currentTimeMinutes;
  });
}

async function persistSchedule(db, routeId, schedule) {
  const docRef = db.collection("routes").doc(routeId);
  await docRef.set(
    {
      schedule,
      schedule_updated_at: new Date().toISOString(),
    },
    { merge: true }
  );

  broadcastWS("schedule_update", { route_id: routeId, schedule });
}

/**
 * Compute reservation summary (waiting_count per stop sequence)
 * used both by the HTTP GET and by WS broadcasts.
 */
export async function computeReservationSummary(db, routeId, direction) {
  const docRef = db.collection("routes").doc(routeId);
  const routeDoc = await docRef.get();
  if (!routeDoc.exists) {
    return { stops: [], maxSeq: -1 };
  }
  const d = routeDoc.data() || {};

  // Build ordered list of stops for this direction
  const rawStops = (d.directions?.[direction] || []).slice();
  const stopsArr = rawStops
    .map((s, idx) => ({
      stop_id: s.stop_id || s.id || `${routeId}_${direction}_${idx}`,
      stop_name: s.stop_name || s.name || `Stop ${idx + 1}`,
      sequence: Number.isFinite(s.sequence) ? Number(s.sequence) : idx,
    }))
    .sort((a, b) => a.sequence - b.sequence);

  const maxSeq =
    stopsArr.length > 0 ? Math.max(...stopsArr.map((s) => s.sequence)) : -1;

  const waitingBySeq = {};
  const now = Date.now();
  const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours TTL for "waiting"

  const rSnap = await db
    .collection("reservations")
    .where("route_id", "==", routeId)
    .where("direction", "==", direction)
    .where("status", "==", "waiting")
    .get();

  rSnap.forEach((doc) => {
    const r = doc.data() || {};
    const createdMs = Date.parse(r.created_at || "") || 0;
    if (createdMs && now - createdMs > MAX_AGE_MS) {
      return; // skip very old reservations
    }
    const src = Number(r.source_sequence);
    const dst = Number(r.dest_sequence);
    if (!Number.isFinite(src) || !Number.isFinite(dst) || dst <= src) {
      return;
    }
    for (let s = src; s < dst && s <= maxSeq + 1; s++) {
      waitingBySeq[s] = (waitingBySeq[s] || 0) + 1;
    }
  });

  const stopsOut = stopsArr.map((s) => ({
    ...s,
    waiting_count: waitingBySeq[s.sequence] || 0,
  }));

  return { stops: stopsOut, maxSeq, countReservations: rSnap.docs.length };
}

/**
 * Reset all "waiting" reservations for a given route+direction
 * (used by the admin reset endpoint and can also be called from
 * driver status transitions running → idle).
 */
async function resetReservationsForRouteDirection(db, routeId, direction) {
  const snap = await db
    .collection("reservations")
    .where("route_id", "==", routeId)
    .where("direction", "==", direction)
    .where("status", "==", "waiting")
    .get();

  if (snap.empty) return;

  const batch = db.batch();
  const nowIso = new Date().toISOString();
  snap.docs.forEach((doc) => {
    batch.update(doc.ref, { status: "reset", updated_at: nowIso });
  });
  await batch.commit();
}

/**
 * Emit a "heat signature" when estimated occupancy > 4.
 *
 * We look at:
 *  - current occupancy & capacity from the first active vehicle
 *  - current number of waiting reservations for this route+direction
 */
async function maybeEmitHeatSignal(db, routeId, direction, deltaReservations) {
  try {
    // 1) get active vehicle for this route+direction
    const vSnap = await db
      .collection("vehicles")
      .where("currentRoute", "==", routeId)
      .where("direction", "==", direction)
      .get();

    if (vSnap.empty) return;
    const vDoc = vSnap.docs[0];
    const v = vDoc.data() || {};
    const occupancy = Number(v.occupancy ?? 0);
    const capacity = Number(v.capacity ?? 4);

    // 2) current waiting count BEFORE this reservation (approx)
    const rSnap = await db
      .collection("reservations")
      .where("route_id", "==", routeId)
      .where("direction", "==", direction)
      .where("status", "==", "waiting")
      .get();

    const existingWaiting = rSnap.size;
    const before = occupancy + existingWaiting - deltaReservations;
    const after = occupancy + existingWaiting;

    // threshold: we only trigger when we CROSS > 4
    if (!(before <= 4 && after > 4)) return;

    const ts = Date.now();
    const expiresAt = ts + 10 * 60 * 1000; // 10 minutes

    const loc = v.location || {};
    const lat = Number(loc.lat ?? loc.latitude ?? 0);
    const lon = Number(loc.lng ?? loc.longitude ?? 0);

    await db.collection("demand_signals").add({
      direction,
      driverEmail: v.driverEmail || v.driver_email || null,
      expires_at: expiresAt,
      high: true,
      lat: lat || null,
      lon: lon || null,
      route_id: routeId,
      stop_id: null,
      ts,
      vehicle_id: vDoc.id,
    });

    await db.collection("vehicles").doc(vDoc.id).set(
      {
        demand_high: true,
        demand_ts: ts,
      },
      { merge: true }
    );

    broadcastWS("heat_update", {
      route_id: routeId,
      direction,
      vehicle_id: vDoc.id,
      lat,
      lon,
      ts,
      estimated_occupancy: after,
      capacity,
    });
  } catch (err) {
    console.error("⚠️ Heat signal error:", err?.message || err);
  }
}

export default function routeRoutes(db) {
  const router = Router();

  // ----------------------------------------------------------------------------
  // PUBLIC: GET routes summary
  // Query params:
  //   - active_only=true: Filter out schedules that have passed for today
  // ----------------------------------------------------------------------------
  router.get("/", async (req, res) => {
    try {
      const activeOnly =
        req.query.active_only === "true" ||
        req.query.active_only === "1" ||
        req.query.activeOnly === "true" ||
        req.query.activeOnly === "1";

      const snapshot = await db.collection("routes").get();
      const routes = snapshot.docs.map((doc) => {
        const d = doc.data();
        const routeName = d.route_name || d.line || d.routeName || doc.id;
        const toStops = d.directions?.to || [];
        const froStops = d.directions?.fro || [];
        let schedule = normalizeSchedule(d.schedule || []);

        // Filter out passed schedules if active_only is requested
        if (activeOnly) {
          schedule = filterActiveSchedules(schedule);
        }

        return {
          id: doc.id,
          route_id: doc.id,
          route_name: routeName,
          to_count: toStops.length,
          fro_count: froStops.length,
          start: toStops[0]?.stop_name || d.start?.name || "Unknown",
          end:
            toStops[toStops.length - 1]?.stop_name ||
            d.end?.name ||
            "Unknown",
          directions: d.directions || {},
          schedule,
        };
      });
      res.json(Array.isArray(routes) ? routes : []);
    } catch (err) {
      console.error("❌ Routes fetch error:", err);
      res.status(500).json({ error: "Failed to fetch routes" });
    }
  });

  // ----------------------------------------------------------------------------
  // PUBLIC: GET flattened stops
  // ----------------------------------------------------------------------------
  router.get("/stops/all", async (_req, res) => {
    try {
      const snapshot = await db.collection("routes").get();
      const stops = [];
      snapshot.forEach((doc) => {
        const d = doc.data();
        const route_id = doc.id;
        const route_name = d.route_name || d.line || route_id;
        if (d.directions?.to) {
          d.directions.to.forEach((s, idx) => {
            stops.push({
              route_id,
              route_name,
              stop_name: s.stop_name,
              lat: s.location?.latitude,
              lon: s.location?.longitude,
              direction: "to",
              sequence: idx,
            });
          });
        }
        if (d.directions?.fro) {
          d.directions.fro.forEach((s, idx) => {
            stops.push({
              route_id,
              route_name,
              stop_name: s.stop_name,
              lat: s.location?.latitude,
              lon: s.location?.longitude,
              direction: "fro",
              sequence: idx,
            });
          });
        }
      });
      res.json(stops);
    } catch (err) {
      console.error("❌ Stops fetch error:", err);
      res.status(500).json({ error: "Failed to fetch stops" });
    }
  });

  // ----------------------------------------------------------------------------
  // PUBLIC: GET drivers by route (+ demand_high)
  // ----------------------------------------------------------------------------
  router.get("/drivers", async (_req, res) => {
    try {
      const now = Date.now();
      const since = now - 10 * 60 * 1000;

      const vSnap = await db.collection("vehicles").get();
      const vehicles = [];
      vSnap.forEach((doc) => {
        const v = doc.data();
        if (v.status === "active" || v.location) {
          vehicles.push({
            id: doc.id,
            route_id: v.currentRoute ?? "unknown",
            route_name: v.route_name ?? "Unknown",
            direction: v.direction ?? "to",
            lat: v.location?.lat ?? 0,
            lon: v.location?.lng ?? 0,
            occupancy: v.occupancy ?? 0,
            capacity: v.capacity ?? 4,
            vacant: (v.capacity ?? 4) - (v.occupancy ?? 0),
            status: v.status ?? "inactive",
            updated_at: v.location?.timestamp
              ? new Date(v.location.timestamp).toISOString()
              : new Date().toISOString(),
            _mirror_demand_high: v.demand_high || false,
            _mirror_demand_ts: v.demand_ts || 0,
          });
        }
      });

      const sSnap = await db
        .collection("demand_signals")
        .where("ts", ">=", since)
        .get();
      const demandByVehicle = {};
      sSnap.forEach((d) => {
        const s = d.data();
        if (s.expires_at > now && s.high) {
          demandByVehicle[s.vehicle_id] = true;
        }
      });

      const merged = vehicles.map((v) => {
        const freshMirror =
          v._mirror_demand_high && v._mirror_demand_ts > since;
        const demand_high = !!(demandByVehicle[v.id] || freshMirror);
        const { _mirror_demand_high, _mirror_demand_ts, ...rest } = v;
        return { ...rest, demand_high };
      });

      const grouped = {};
      for (const a of merged) {
        const key = `${a.route_id}_${a.direction}`;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(a);
      }

      res.json({ count: merged.length, grouped, vehicles: merged });
    } catch (err) {
      console.error("❌ Drivers fetch error:", err);
      res.status(500).json({ error: "Failed to fetch active drivers" });
    }
  });

  // ----------------------------------------------------------------------------
  // SCHEDULES
  // ----------------------------------------------------------------------------
  router.get("/:id/schedule", async (req, res) => {
    try {
      const { id } = req.params;
      const activeOnly =
        req.query.active_only === "true" ||
        req.query.active_only === "1" ||
        req.query.activeOnly === "true" ||
        req.query.activeOnly === "1";

      const doc = await db.collection("routes").doc(id).get();
      if (!doc.exists) return res.status(404).json({ error: "Route not found" });
      const d = doc.data() || {};
      let schedule = normalizeSchedule(d.schedule || []);

      // Filter out passed schedules if active_only is requested
      if (activeOnly) {
        schedule = filterActiveSchedules(schedule);
      }

      res.json({ route_id: id, schedule, schedule_updated_at: d.schedule_updated_at || null });
    } catch (err) {
      console.error("❌ Schedule fetch error:", err);
      res.status(500).json({ error: "Failed to fetch schedule" });
    }
  });

  router.put("/:id/schedule", authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const incoming = req.body?.schedule ?? req.body?.entries ?? req.body;
      if (!Array.isArray(incoming)) {
        return res.status(400).json({ error: "schedule array is required" });
      }

      const docRef = db.collection("routes").doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "Route not found" });

      const schedule = normalizeSchedule(incoming);
      await persistSchedule(db, id, schedule);
      res.json({ route_id: id, schedule });
    } catch (err) {
      console.error("❌ Schedule save error:", err);
      res.status(500).json({
        error: "Failed to save schedule",
        details: err?.message || err,
      });
    }
  });

  router.post("/:id/schedule", authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const entryRaw = req.body?.entry ?? req.body;
      const [entry] = normalizeSchedule([
        {
          ...entryRaw,
          id:
            entryRaw?.id ||
            entryRaw?.schedule_id ||
            entryRaw?.trip_id ||
            `sch_${genId().slice(0, 6)}`,
        },
      ]);

      if (!entry) {
        return res.status(400).json({ error: "Valid startTime is required" });
      }

      const docRef = db.collection("routes").doc(id);
      const doc = await docRef.get();
      if (!doc.exists) return res.status(404).json({ error: "Route not found" });

      const existing = normalizeSchedule(doc.data()?.schedule || []);
      const merged = existing
        .filter((s) => s.id !== entry.id)
        .concat([{ ...entry, sequence: Number.isFinite(entry.sequence) ? entry.sequence : existing.length }])
        .sort((a, b) => {
          if (a.direction !== b.direction) return a.direction === "to" ? -1 : 1;
          return a.startTime.localeCompare(b.startTime);
        })
        .map((s, idx) => ({ ...s, sequence: idx }));

      await persistSchedule(db, id, merged);
      res.json({ route_id: id, schedule: merged });
    } catch (err) {
      console.error("❌ Schedule add error:", err);
      res.status(500).json({ error: "Failed to add schedule entry" });
    }
  });

  router.patch(
    "/:id/schedule/:scheduleId",
    authenticate,
    requireAdmin,
    async (req, res) => {
      try {
        const { id, scheduleId } = req.params;
        const docRef = db.collection("routes").doc(id);
        const doc = await docRef.get();
        if (!doc.exists) return res.status(404).json({ error: "Route not found" });

        const existing = normalizeSchedule(doc.data()?.schedule || []);
        const idx = existing.findIndex((s) => s.id === scheduleId);
        if (idx < 0) {
          return res.status(404).json({ error: "Schedule entry not found" });
        }

        const [updated] = normalizeSchedule([
          { ...existing[idx], ...req.body, id: scheduleId },
        ]);
        if (!updated) {
          return res.status(400).json({ error: "Valid startTime is required" });
        }

        const next = existing
          .map((s, i) => (i === idx ? updated : s))
          .sort((a, b) => {
            if (a.direction !== b.direction) return a.direction === "to" ? -1 : 1;
            return a.startTime.localeCompare(b.startTime);
          })
          .map((s, i) => ({ ...s, sequence: i }));

        await persistSchedule(db, id, next);
        res.json({ route_id: id, schedule: next });
      } catch (err) {
        console.error("❌ Schedule update error:", err);
        res.status(500).json({ error: "Failed to update schedule entry" });
      }
    }
  );

  router.delete(
    "/:id/schedule/:scheduleId",
    authenticate,
    requireAdmin,
    async (req, res) => {
      try {
        const { id, scheduleId } = req.params;
        const docRef = db.collection("routes").doc(id);
        const doc = await docRef.get();
        if (!doc.exists) return res.status(404).json({ error: "Route not found" });

        const existing = normalizeSchedule(doc.data()?.schedule || []);
        const next = existing
          .filter((s) => s.id !== scheduleId)
          .map((s, idx) => ({ ...s, sequence: idx }));

        await persistSchedule(db, id, next);
        res.json({ route_id: id, schedule: next });
      } catch (err) {
        console.error("❌ Schedule delete error:", err);
        res.status(500).json({ error: "Failed to delete schedule entry" });
      }
    }
  );

  // ----------------------------------------------------------------------------
  // USER: Create a reservation for a route (source → destination stops)
  // POST /routes/:id/reservations
  //
  // Uses Firestore transaction to prevent race conditions when multiple users
  // create reservations simultaneously.
  // ----------------------------------------------------------------------------
  router.post("/:id/reservations", authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const {
        direction = "to",
        source_stop_id,
        dest_stop_id,
        source_sequence,
        dest_sequence,
      } = req.body || {};

      const dir = (direction || "to").toString().toLowerCase();
      if (!["to", "fro"].includes(dir)) {
        return res
          .status(400)
          .json({ error: "direction must be 'to' or 'fro'" });
      }

      const srcSeq = Number(source_sequence);
      const dstSeq = Number(dest_sequence);

      if (!Number.isFinite(srcSeq) || !Number.isFinite(dstSeq)) {
        return res.status(400).json({
          error: "source_sequence and dest_sequence must be numbers",
        });
      }
      if (dstSeq <= srcSeq) {
        return res.status(400).json({
          error: "Destination stop must be after source stop",
        });
      }

      const routeDoc = await db.collection("routes").doc(id).get();
      if (!routeDoc.exists) {
        return res.status(404).json({ error: "Route not found" });
      }

      const userEmail =
        req.user?.email ||
        req.user?.uid ||
        req.user?.id ||
        req.user?.user_id ||
        null;
      if (!userEmail) {
        return res
          .status(400)
          .json({ error: "User identity not found in token" });
      }

      // Use transaction to atomically check for existing reservation and create new one
      const result = await db.runTransaction(async (transaction) => {
        // Check for existing active reservation by this user
        const existingMySnap = await db
          .collection("reservations")
          .where("user_email", "==", userEmail)
          .where("status", "==", "waiting")
          .limit(1)
          .get();

        if (!existingMySnap.empty) {
          throw new Error("ALREADY_HAS_RESERVATION");
        }

        // Count existing reservations for this route+direction (for heat logic)
        const existingRouteSnap = await db
          .collection("reservations")
          .where("route_id", "==", id)
          .where("direction", "==", dir)
          .where("status", "==", "waiting")
          .get();
        const countBefore = existingRouteSnap.size;

        const payload = {
          route_id: id,
          direction: dir,
          source_stop_id: String(source_stop_id || ""),
          dest_stop_id: String(dest_stop_id || ""),
          source_sequence: srcSeq,
          dest_sequence: dstSeq,
          user_email: userEmail,
          status: "waiting",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        // Create new reservation document
        const newRef = db.collection("reservations").doc();
        transaction.set(newRef, payload);

        return { refId: newRef.id, payload, countBefore };
      });

      // Recompute summary & broadcast (outside transaction)
      const summary = await computeReservationSummary(db, id, dir);
      broadcastWS("reservation_update", {
        route_id: id,
        direction: dir,
        stops: summary.stops,
      });

      // Check for heat signal (deltaReservations = +1)
      await maybeEmitHeatSignal(db, id, dir, +1);

      res.json({ id: result.refId, ...result.payload });
    } catch (err) {
      if (err.message === "ALREADY_HAS_RESERVATION") {
        return res.status(400).json({
          error:
            "You already have an active reservation. Please cancel it before creating a new one.",
        });
      }
      console.error("❌ Create reservation error:", err);
      res.status(500).json({ error: "Failed to create reservation" });
    }
  });

  // ----------------------------------------------------------------------------
  // PUBLIC: Reservation summary per stop for a route+direction
  // GET /routes/:id/reservations/summary?direction=to|fro
  // ----------------------------------------------------------------------------
  router.get("/:id/reservations/summary", async (req, res) => {
    try {
      const { id } = req.params;
      const dirRaw = (req.query.direction || "to").toString().toLowerCase();
      const direction = dirRaw === "fro" ? "fro" : "to";

      const summary = await computeReservationSummary(db, id, direction);
      res.json({ route_id: id, direction, stops: summary.stops });
    } catch (err) {
      console.error("❌ Reservations summary error:", err);
      res
        .status(500)
        .json({ error: "Failed to fetch reservation summary" });
    }
  });

  // ----------------------------------------------------------------------------
  // USER: Get my active reservation for this route+direction
  // GET /routes/:id/reservations/my?direction=to|fro
  // ----------------------------------------------------------------------------
  router.get("/:id/reservations/my", authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const dirRaw = (req.query.direction || "to").toString().toLowerCase();
      const direction = dirRaw === "fro" ? "fro" : "to";

      const userEmail =
        req.user?.email ||
        req.user?.uid ||
        req.user?.id ||
        req.user?.user_id ||
        null;
      if (!userEmail) {
        return res
          .status(400)
          .json({ error: "User identity not found in token" });
      }

      const snap = await db
        .collection("reservations")
        .where("route_id", "==", id)
        .where("direction", "==", direction)
        .where("user_email", "==", userEmail)
        .where("status", "==", "waiting")
        .limit(1)
        .get();

      if (snap.empty) {
        return res.status(404).json({ error: "No active reservation" });
      }

      const doc = snap.docs[0];
      res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
      console.error("❌ Get my reservation error:", err);
      res
        .status(500)
        .json({ error: "Failed to fetch active reservation" });
    }
  });

  // ----------------------------------------------------------------------------
  // USER: Cancel my active reservation
  // DELETE /routes/:id/reservations/my?direction=to|fro
  // ----------------------------------------------------------------------------
  router.delete("/:id/reservations/my", authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const dirRaw = (req.query.direction || "to").toString().toLowerCase();
      const direction = dirRaw === "fro" ? "fro" : "to";

      const userEmail =
        req.user?.email ||
        req.user?.uid ||
        req.user?.id ||
        req.user?.user_id ||
        null;
      if (!userEmail) {
        return res
          .status(400)
          .json({ error: "User identity not found in token" });
      }

      const snap = await db
        .collection("reservations")
        .where("route_id", "==", id)
        .where("direction", "==", direction)
        .where("user_email", "==", userEmail)
        .where("status", "==", "waiting")
        .limit(1)
        .get();

      if (snap.empty) {
        return res.status(404).json({ error: "No active reservation" });
      }

      const doc = snap.docs[0];
      await doc.ref.update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      });

      // Recompute summary & broadcast (deltaReservations = -1)
      const summary = await computeReservationSummary(db, id, direction);
      broadcastWS("reservation_update", {
        route_id: id,
        direction,
        stops: summary.stops,
      });
      await maybeEmitHeatSignal(db, id, direction, -1);

      res.json({ ok: true });
    } catch (err) {
      console.error("❌ Cancel reservation error:", err);
      res.status(500).json({ error: "Failed to cancel reservation" });
    }
  });

  // ----------------------------------------------------------------------------
  // ADMIN: Reset all waiting reservations for route+direction
  // POST /routes/:id/reservations/reset
  // ----------------------------------------------------------------------------
  router.post(
    "/:id/reservations/reset",
    authenticate,
    requireAdmin,
    async (req, res) => {
      try {
        const { id } = req.params;
        const dirRaw = (req.body.direction || req.query.direction || "to")
          .toString()
          .toLowerCase();
        const direction = dirRaw === "fro" ? "fro" : "to";

        await resetReservationsForRouteDirection(db, id, direction);

        const summary = await computeReservationSummary(db, id, direction);
        broadcastWS("reservation_update", {
          route_id: id,
          direction,
          stops: summary.stops,
        });

        res.json({ ok: true });
      } catch (err) {
        console.error("❌ Reset reservations error:", err);
        res
          .status(500)
          .json({ error: "Failed to reset reservations for route" });
      }
    }
  );

  // ---------------------------------------------------------------------------
  // PUBLIC – route shape
  // ---------------------------------------------------------------------------
  router.get("/:id/shape", async (req, res) => {
    try {
      const { id } = req.params;
      const dirRaw = (req.query.direction || "to").toString().toLowerCase();
      const direction = dirRaw === "fro" ? "fro" : "to";
      const force =
        req.query.force === "1" ||
        req.query.force === "true" ||
        req.query.force === "yes";

      const docRef = db.collection("routes").doc(id);
      const doc = await docRef.get();
      if (!doc.exists) {
        return res.status(404).json({ error: "Route not found" });
      }
      const d = doc.data() || {};

      const cache = d.shape_cache?.[direction];
      if (
        !force &&
        cache &&
        Array.isArray(cache.points) &&
        cache.points.length > 1
      ) {
        return res.json({
          route_id: id,
          direction,
          points: cache.points,
          from_cache: true,
        });
      }

      const rawStops = (d.directions?.[direction] || []).slice();
      const stops = rawStops
        .map((s, i) => ({
          ...s,
          sequence: Number.isFinite(s.sequence) ? s.sequence : i,
        }))
        .sort((a, b) => a.sequence - b.sequence)
        .filter(
          (s) =>
            typeof s.location?.latitude === "number" &&
            typeof s.location?.longitude === "number"
        );

      if (stops.length < 2) {
        return res.status(400).json({
          error:
            "Not enough stops with coordinates to build a route shape",
        });
      }

      let pointsToReturn = await getRoutePolylineForStops(stops);

      if (!pointsToReturn || pointsToReturn.length < 2) {
        return res.status(502).json({
          error:
            "Google Directions could not build a usable road-following polyline",
        });
      }

      try {
        const existingCache = d.shape_cache || {};
        existingCache[direction] = {
          points: pointsToReturn,
          updated_at: new Date().toISOString(),
        };
        await docRef.set({ shape_cache: existingCache }, { merge: true });
      } catch (err) {
        console.error(
          "⚠️ Failed to cache route shape:",
          err.message || err
        );
      }

      res.json({
        route_id: id,
        direction,
        points: pointsToReturn,
        from_cache: false,
      });
    } catch (err) {
      console.error("❌ Route shape error:", err);
      res.status(500).json({ error: "Failed to compute route shape" });
    }
  });

  // ----------------------------------------------------------------------------
  // PUBLIC: GET single route detail
  // ----------------------------------------------------------------------------
  router.get("/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const routeDoc = await db.collection("routes").doc(id).get();
      if (!routeDoc.exists)
        return res.status(404).json({ error: "Route not found" });

      const d = routeDoc.data();
      const routeName = d.route_name || d.line || d.routeName || id;
      const toStops = (d.directions?.to || []).map((s, idx) => ({
        ...s,
        lat: s.location?.latitude,
        lon: s.location?.longitude,
        direction: "to",
        sequence: Number.isFinite(s.sequence) ? s.sequence : idx,
        route_id: id,
        route_name: routeName,
      }));
      const froStops = (d.directions?.fro || []).map((s, idx) => ({
        ...s,
        lat: s.location?.latitude,
        lon: s.location?.longitude,
        direction: "fro",
        sequence: Number.isFinite(s.sequence) ? s.sequence : idx,
        route_id: id,
        route_name: routeName,
      }));

      res.json({
        id,
        route_name: routeName,
        directions: { to: toStops, fro: froStops },
        total_stops: toStops.length + froStops.length,
        schedule: normalizeSchedule(d.schedule || []),
        schedule_updated_at: d.schedule_updated_at || null,
      });
    } catch (err) {
      console.error("❌ Route detail fetch error:", err);
      res.status(500).json({ error: "Failed to fetch route detail" });
    }
  });

  // ============================================================================
  // ADMIN CRUD
  // ============================================================================
  router.post("/", authenticate, requireAdmin, async (req, res) => {
    try {
      const { route_name } = req.body || {};
      if (!route_name || !String(route_name).trim()) {
        return res.status(400).json({ error: "route_name is required" });
      }
      const ref = await db.collection("routes").add({
        route_name: String(route_name).trim(),
        directions: { to: [], fro: [] },
        created_at: new Date().toISOString(),
      });
      res.json({ id: ref.id });
    } catch (err) {
      console.error("❌ Create route error:", err);
      res.status(500).json({ error: "Failed to create route" });
    }
  });

  // ✅ FIXED: rename now always persists if provided, and blanks are rejected
  router.put("/:id", authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { route_name, directions } = req.body || {};
      const payload = {};

      if (route_name !== undefined) {
        const trimmed = String(route_name).trim();
        if (!trimmed) {
          return res.status(400).json({ error: "route_name cannot be empty" });
        }
        payload["route_name"] = trimmed;
      }

      if (directions !== undefined) {
        payload["directions"] = normalizeDirections(directions);
      }

      await db.collection("routes").doc(id).set(payload, { merge: true });
      res.json({ ok: true });
    } catch (err) {
      console.error("❌ Update route error:", err);
      res.status(500).json({ error: "Failed to update route" });
    }
  });

  router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      await db.collection("routes").doc(id).delete();
      res.json({ ok: true });
    } catch (err) {
      console.error("❌ Delete route error:", err);
      res.status(500).json({ error: "Failed to delete route" });
    }
  });

  router.post("/:id/stops", authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { direction = "to", stop_name, latitude, longitude } =
        req.body || {};
      if (!["to", "fro"].includes(direction))
        return res
          .status(400)
          .json({ error: "direction must be 'to' or 'fro'" });
      if (!stop_name)
        return res.status(400).json({ error: "stop_name required" });

      const doc = await db.collection("routes").doc(id).get();
      if (!doc.exists)
        return res.status(404).json({ error: "Route not found" });
      const d = doc.data() || {};
      const dirs = normalizeDirections(d.directions || {});
      const newStop = {
        stop_id: genId(),
        stop_name: String(stop_name),
        location: {
          latitude: Number(latitude),
          longitude: Number(longitude),
        },
        sequence: dirs[direction].length,
      };
      dirs[direction].push(newStop);
      await db
        .collection("routes")
        .doc(id)
        .set({ directions: dirs }, { merge: true });
      res.json(newStop);
    } catch (err) {
      console.error("❌ Add stop error:", err);
      res.status(500).json({ error: "Failed to add stop" });
    }
  });

  router.put(
    "/:id/stops/:stopId",
    authenticate,
    requireAdmin,
    async (req, res) => {
      try {
        const { id, stopId } = req.params;
        const {
          direction = "to",
          stop_name,
          latitude,
          longitude,
          sequence,
        } = req.body || {};
        if (!["to", "fro"].includes(direction))
          return res
            .status(400)
            .json({ error: "direction must be 'to' or 'fro'" });

        const doc = await db.collection("routes").doc(id).get();
        if (!doc.exists)
          return res.status(404).json({ error: "Route not found" });
        const d = doc.data() || {};
        const dirs = normalizeDirections(d.directions || {});
        const idx = dirs[direction].findIndex((s) => s.stop_id === stopId);
        if (idx < 0) return res.status(404).json({ error: "Stop not found" });

        const prev = dirs[direction][idx];
        const next = { ...prev };
        if (stop_name) next.stop_name = String(stop_name);
        if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
          next.location = {
            latitude: Number(latitude),
            longitude: Number(longitude),
          };
        }
        dirs[direction][idx] = next;

        if (Number.isFinite(sequence)) {
          const arr = dirs[direction];
          const [moved] = arr.splice(idx, 1);
          const target = Math.max(0, Math.min(arr.length, Number(sequence)));
          arr.splice(target, 0, moved);
          dirs[direction] = arr.map((s, i) => ({ ...s, sequence: i }));
        }

        await db
          .collection("routes")
          .doc(id)
          .set({ directions: dirs }, { merge: true });
        res.json({ ok: true });
      } catch (err) {
        console.error("❌ Update stop error:", err);
        res.status(500).json({ error: "Failed to update stop" });
      }
    }
  );

  router.delete(
    "/:id/stops/:stopId",
    authenticate,
    requireAdmin,
    async (req, res) => {
      try {
        const { id, stopId } = req.params;
        const { direction = "to" } = req.query;
        const dir = typeof direction === "string" ? direction : "to";
        if (!["to", "fro"].includes(dir))
          return res
            .status(400)
            .json({ error: "direction must be 'to' or 'fro'" });

        const doc = await db.collection("routes").doc(id).get();
        if (!doc.exists)
          return res.status(404).json({ error: "Route not found" });
        const d = doc.data() || {};
        const dirs = normalizeDirections(d.directions || {});
        dirs[dir] = dirs[dir]
          .filter((s) => s.stop_id !== stopId)
          .map((s, i) => ({ ...s, sequence: i }));

        await db
          .collection("routes")
          .doc(id)
          .set({ directions: dirs }, { merge: true });
        res.json({ ok: true });
      } catch (err) {
        console.error("❌ Delete stop error:", err);
        res.status(500).json({ error: "Failed to delete stop" });
      }
    }
  );

  return router;
}
