// backend/src/routes/reports.js
// Trip analytics backed by real Firestore `trip_summary` data,
// but carefully avoids multi-field range queries so no manual indexes are needed.

import express from "express";
import admin from "firebase-admin";

/**
 * Helper: parse time window & line (route) selection from query params.
 *
 * Query params:
 *  - from: ISO date or datetime (optional, defaults to "now - 6h")
 *  - to:   ISO date or datetime (optional, defaults to "now")
 *  - line / line_id: route_id or "all" (optional, defaults to "all")
 *  - direction: "to" | "fro" | "all" (optional, defaults to "all")
 */
function parseWindow(req) {
  const { from, to, line, line_id, direction } = req.query;

  const now = new Date();

  const fromDate = from
    ? new Date(from)
    : new Date(now.getTime() - 6 * 60 * 60 * 1000); // last 6h
  const toDate = to ? new Date(to) : now;

  const fromTs = admin.firestore.Timestamp.fromDate(fromDate);
  const toTs = admin.firestore.Timestamp.fromDate(toDate);

  const lineId = (line || line_id || "all").toString();
  const dir = (direction || "all").toString().toLowerCase(); // "to" | "fro" | "all"

  return {
    fromDate,
    toDate,
    fromTs,
    toTs,
    lineId,
    direction: dir,
  };
}

/**
 * Helper: load trips from Firestore.
 *
 * IMPORTANT: we ONLY filter on start_time in Firestore:
 *   trip_summary.where("start_time", ">=", from).where("start_time", "<=", to)
 *
 * All other filters (route/driver/end_time/direction) are done in memory to avoid
 * multiple range filters that require composite indexes.
 *
 * Also normalizes route_id vs line_id so both old & new writers work:
 *  - Accepts docs with any of: route_id, line_id, routeId, lineId
 *  - Exposes a canonical `route_id` on each trip object (and back-fills `line_id`)
 */
async function loadTrips(db, req) {
  const { fromDate, toDate, fromTs, toTs, lineId, direction } = parseWindow(
    req
  );

  const lineIdNorm =
    lineId === "all"
      ? "all"
      : lineId.toString().trim().toLowerCase() || "all";

  // Base query: only on start_time so Firestore is happy.
  let q = db
    .collection("trip_summary")
    .where("start_time", ">=", fromTs)
    .where("start_time", "<=", toTs);

  const snap = await q.get();

  const trips = [];

  snap.forEach((doc) => {
    const data = doc.data();

    // Normalize start/end times into JS Date objects
    const start =
      data.start_time && typeof data.start_time.toDate === "function"
        ? data.start_time.toDate()
        : data.start_time
        ? new Date(data.start_time)
        : null;

    const rawEnd =
      data.end_time && typeof data.end_time.toDate === "function"
        ? data.end_time.toDate()
        : data.end_time
        ? new Date(data.end_time)
        : null;

    if (!start) return; // malformed trip

    const end = rawEnd || start;

    // Canonical route_id / line_id handling
    const routeIdRaw =
      data.route_id ??
      data.line_id ??
      data.routeId ??
      data.lineId ??
      null;

    const routeIdNorm =
      routeIdRaw != null
        ? routeIdRaw.toString().trim().toLowerCase()
        : null;

    // In-memory route filter to avoid composite index;
    // supports both route_id and line_id on stored docs.
    if (
      lineIdNorm !== "all" &&
      routeIdNorm &&
      routeIdNorm !== lineIdNorm
    ) {
      return;
    }

    // In-memory direction filter ("to" / "fro")
    if (direction !== "all") {
      const d = (data.direction || data.dir || "")
        .toString()
        .toLowerCase();
      if (d !== direction) return;
    }

    // Ensure the trip actually overlaps the requested window
    if (end < fromDate || start > toDate) return;

    const base = { ...data };

    // Back-fill canonical route_id + line_id so downstream code
    // (summary/anomalies/drivers) always has route_id.
    if (routeIdRaw != null) {
      base.route_id = base.route_id ?? routeIdRaw;
      base.line_id = base.line_id ?? routeIdRaw;
    }

    trips.push({
      id: doc.id,
      ...base,
      start,
      end,
    });
  });

  return { trips, fromDate, toDate, lineId, direction };
}

// Small helpers
const pad2 = (n) => (n < 10 ? `0${n}` : String(n));
const weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// 🔹 Dummy geo hotspots used if trip data is empty (great for demos)
const DUMMY_HOTSPOTS = [
  { lat: 12.9716, lon: 77.5946, count: 80 }, // Bengaluru core
  { lat: 12.9750, lon: 77.6000, count: 65 }, // Campus ring A
  { lat: 12.9650, lon: 77.5900, count: 42 }, // Campus ring B
  { lat: 28.6139, lon: 77.2090, count: 55 }, // Delhi
  { lat: 19.0760, lon: 72.8777, count: 50 }, // Mumbai
  { lat: 17.3850, lon: 78.4867, count: 42 }, // Hyderabad
  { lat: 13.0827, lon: 80.2707, count: 38 }, // Chennai
  { lat: 22.5726, lon: 88.3639, count: 34 }, // Kolkata
];

export default function reportsRoutes(db) {
  const router = express.Router();

    // ---------------------------------------------------------------------------
  // GET /reports/summary
  // KPI strip: total trips, distance, avg duration, active drivers, peak hour
  // + feedback stats
  // Shape matches `Summary` in Reports.tsx (with optional .feedback)
  // ---------------------------------------------------------------------------
  router.get("/summary", async (req, res) => {
    try {
      const {
        trips,
        fromDate,
        toDate,
        lineId,
        direction,
      } = await loadTrips(db, req);

      const totalTrips = trips.length;

      let totalDistanceKm = 0;
      let totalDurationSec = 0;
      const drivers = new Set();
      const tripsPerHourOfDay = new Array(24).fill(0); // 0–23

      for (const t of trips) {
        const dist = Number(
          t.distance_km ?? t.distanceKm ?? t.distance ?? 0
        );
        if (!Number.isNaN(dist)) totalDistanceKm += dist;

        const durSec =
          t.duration_sec ??
          t.durationSec ??
          Math.max(
            0,
            Math.round((t.end.getTime() - t.start.getTime()) / 1000)
          );
        totalDurationSec += durSec;

        if (t.driver_id) drivers.add(t.driver_id);

        const h = t.start.getHours();
        if (h >= 0 && h < 24) {
          tripsPerHourOfDay[h] += 1;
        }
      }

      const avgDurationSec = totalTrips
        ? totalDurationSec / totalTrips
        : 0;

      // Peak hour-of-day label, e.g. "14:00–15:00"
      let peakHourIdx = null;
      let peakTrips = 0;
      tripsPerHourOfDay.forEach((count, hour) => {
        if (count > peakTrips) {
          peakTrips = count;
          peakHourIdx = hour;
        }
      });

      let peakUsage = "N/A";
      if (peakHourIdx != null) {
        const nextHour = (peakHourIdx + 1) % 24;
        peakUsage = `${pad2(peakHourIdx)}:00–${pad2(nextHour)}:00`;
      }

      const totalDistanceRounded = Number(totalDistanceKm.toFixed(2));
      const avgDurationSecRounded = Math.round(avgDurationSec);

      // 🔹 New: aggregate feedback for this window + (optionally) this line
      let feedbackStats = {
        count: 0,
        avgRating: null,
        netScore: 0,
        score: 70, // neutral baseline (0–100)
      };

      try {
        const fromIso = fromDate.toISOString();
        const toIso = toDate.toISOString();
        const fbSnap = await db
          .collection("feedback")
          .where("timestamp", ">=", fromIso)
          .where("timestamp", "<=", toIso)
          .get();

        let sum = 0;
        let count = 0;

        fbSnap.forEach((doc) => {
          const fb = doc.data() || {};
          // We treat vehicle_id in feedback as the route/line id we sent from the app
          if (
            lineId !== "all" &&
            String(fb.vehicle_id || "")
              .trim()
              .toLowerCase() !== String(lineId).trim().toLowerCase()
          ) {
            return;
          }

          const r = Number(fb.rating);
          if (Number.isNaN(r)) return;
          sum += r;
          count += 1;
        });

        if (count > 0) {
          const avg = sum / count;
          const clamped = Math.max(-1, Math.min(1, avg)); // [-1,1]
          const score01 = (clamped + 1) / 2; // [0,1]
          feedbackStats = {
            count,
            avgRating: Number(avg.toFixed(2)),
            netScore: Number(sum.toFixed(2)),
            score: Math.round(score01 * 100),
          };
        }
      } catch (err) {
        console.error("❌ Reports feedback summary error:", err);
      }

      const payload = {
        totalTrips,
        totalDistance: totalDistanceRounded,
        avgDuration: avgDurationSecRounded,
        activeDrivers: drivers.size,
        peakUsage,
        window: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
        },
        filters: {
          line_id: lineId === "all" ? null : lineId,
          direction,
        },
        // ⭐ New – used by admin UI's route health calculator
        feedback: feedbackStats,
      };

      return res.json(payload);
    } catch (err) {
      console.error("❌ Reports summary error:", err);
      return res.status(500).json({
        error: "summary_failed",
        message: err.message || String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /reports/temporal
  // Time series: trips per hour-of-day (0–23)
  // Shape: [{ hour: number, trips: number }]
  // ---------------------------------------------------------------------------
  router.get("/temporal", async (req, res) => {
    try {
      const { trips } = await loadTrips(db, req);

      const buckets = new Array(24).fill(0); // 0–23

      for (const trip of trips) {
        const h = trip.start.getHours();
        if (h >= 0 && h < 24) {
          buckets[h] += 1;
        }
      }

      const hourly = buckets.map((count, hour) => ({
        hour,
        trips: count,
      }));

      return res.json({ hourly });
    } catch (err) {
      console.error("❌ Reports temporal error:", err);
      return res.status(500).json({
        error: "temporal_failed",
        message: err.message || String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /reports/drivers
  // Top drivers: trips, distance, avg rating
  // Shape: array<DriverRow> matching Reports.tsx
  // ---------------------------------------------------------------------------
  router.get("/drivers", async (req, res) => {
    try {
      const { trips } = await loadTrips(db, req);

      const byDriver = new Map();

      for (const t of trips) {
        const id = t.driver_id || "unknown";
        if (!byDriver.has(id)) {
          byDriver.set(id, {
            driver_id: id,
            name: t.driver_name || t.driverName || "Unknown",
            trips: 0,
            distance_km: 0,
            ratingSum: 0,
            ratingCount: 0,
          });
        }

        const d = byDriver.get(id);
        d.trips += 1;

        const dist = Number(
          t.distance_km ?? t.distanceKm ?? t.distance ?? 0
        );
        if (!Number.isNaN(dist)) d.distance_km += dist;

        if (t.rating != null) {
          d.ratingSum += Number(t.rating);
          d.ratingCount += 1;
        }
      }

      const drivers = Array.from(byDriver.values())
        .map((d) => ({
          driver_id: d.driver_id,
          name: d.name,
          trips: d.trips,
          distance_km: Number(d.distance_km.toFixed(2)),
          rating:
            d.ratingCount > 0
              ? Number((d.ratingSum / d.ratingCount).toFixed(2))
              : null,
        }))
        .sort((a, b) => b.trips - a.trips || b.distance_km - a.distance_km)
        .slice(0, 50);

      return res.json(drivers);
    } catch (err) {
      console.error("❌ Reports drivers error:", err);
      return res.status(500).json({
        error: "drivers_failed",
        message: err.message || String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /reports/geo
  // Geo hotspots: rough grid bins of trip start locations
  // Shape: array<{ lat, lon, count }>
  // ---------------------------------------------------------------------------
  router.get("/geo", async (req, res) => {
    try {
      const { trips } = await loadTrips(db, req);

      const zones = new Map();

      for (const t of trips) {
        const lat =
          t.start_lat ??
          t.startLat ??
          t.start_location?.lat ??
          t.start_location?.latitude;
        const lng =
          t.start_lng ??
          t.startLng ??
          t.start_location?.lng ??
          t.start_location?.longitude;

        if (lat == null || lng == null) continue;

        // Snap to ~100m grid (0.001 degrees)
        const snapLat = Math.round(Number(lat) * 1000) / 1000;
        const snapLng = Math.round(Number(lng) * 1000) / 1000;
        const key = `${snapLat},${snapLng}`;

        if (!zones.has(key)) {
          zones.set(key, {
            lat: snapLat,
            lon: snapLng,
            count: 0,
          });
        }
        zones.get(key).count += 1;
      }

      let hotspots = Array.from(zones.values()).sort(
        (a, b) => b.count - a.count
      );

      // 🔹 If there is no real trip data yet, serve dummy hotspots
      if (!hotspots.length) {
        hotspots = DUMMY_HOTSPOTS;
      }

      return res.json(hotspots);
    } catch (err) {
      console.error("❌ Reports geo error:", err);
      return res.status(500).json({
        error: "geo_failed",
        message: err.message || String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /reports/anomalies
  // Long vs short trips + p95 duration
  // Shape matches Anomalies type in Reports.tsx
  // ---------------------------------------------------------------------------
  router.get("/anomalies", async (req, res) => {
    try {
      const { trips } = await loadTrips(db, req);

      if (!trips.length) {
        return res.json({
          longTrips: [],
          shortTrips: [],
          p95: 0,
          counts: { longTrips: 0, shortTrips: 0 },
          p95DurationMin: 0,
        });
      }

      const durationsSec = trips.map((t) => {
        const durSec =
          t.duration_sec ??
          t.durationSec ??
          Math.max(
            0,
            Math.round((t.end.getTime() - t.start.getTime()) / 1000)
          );
        return durSec;
      });

      durationsSec.sort((a, b) => a - b);
      const idx = Math.floor(0.95 * (durationsSec.length - 1));
      const p95Sec = durationsSec[idx];

      const longTrips = [];
      const shortTrips = [];

      for (const t of trips) {
        const durSec =
          t.duration_sec ??
          t.durationSec ??
          Math.max(
            0,
            Math.round((t.end.getTime() - t.start.getTime()) / 1000)
          );
        const distKm = Number(
          t.distance_km ?? t.distanceKm ?? t.distance ?? 0
        );

        const row = {
          id: t.id,
          line_id: t.route_id ?? t.line_id ?? null,
          duration_s: durSec,
          distance_km: Number(distKm.toFixed(3)),
          start_time: t.start.toISOString(),
        };

        if (durSec > p95Sec) {
          longTrips.push(row);
        }

        // "Very short": under 5 minutes OR under 0.2 km
        if (durSec < 5 * 60 || distKm < 0.2) {
          shortTrips.push(row);
        }
      }

      const payload = {
        longTrips,
        shortTrips,
        p95: p95Sec,
        counts: {
          longTrips: longTrips.length,
          shortTrips: shortTrips.length,
        },
        p95DurationMin: Number((p95Sec / 60).toFixed(1)),
      };

      return res.json(payload);
    } catch (err) {
      console.error("❌ Reports anomalies error:", err);
      return res.status(500).json({
        error: "anomalies_failed",
        message: err.message || String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /reports/demand
  // Demand signals report: shows all high demand signals for analysis
  // Used for long-term planning - identify hotspots and peak demand times
  // Shape: { signals: Array<DemandSignal>, summary: { total, byRoute, byHour, hotspots } }
  // ---------------------------------------------------------------------------
  router.get("/demand", async (req, res) => {
    try {
      const { fromDate, toDate, lineId, direction } = parseWindow(req);

      // Query demand_signals collection
      let q = db.collection("demand_signals")
        .where("high", "==", true)
        .orderBy("ts", "desc");

      const snap = await q.get();

      const signals = [];
      const byRoute = new Map();
      const byHour = new Array(24).fill(0);
      const locationBuckets = new Map();

      snap.forEach((doc) => {
        const d = doc.data();

        // Parse timestamp
        const ts = d.ts || (d.timestamp ? new Date(d.timestamp).getTime() : 0);
        const signalDate = new Date(ts);

        // Filter by time window
        if (signalDate < fromDate || signalDate > toDate) return;

        // Filter by route
        const routeIdNorm = (d.route_id || "").toString().trim().toLowerCase();
        if (lineId !== "all" && routeIdNorm !== lineId.toLowerCase()) return;

        // Filter by direction
        const dir = (d.direction || "to").toString().toLowerCase();
        if (direction !== "all" && dir !== direction) return;

        const signal = {
          id: doc.id,
          vehicle_id: d.vehicle_id,
          vehicle_plate: d.vehicle_plate || d.vehicle_id,
          route_id: d.route_id,
          route_name: d.route_name || d.route_id,
          direction: d.direction || "to",
          driver_id: d.driver_id,
          driver_name: d.driver_name || "Unknown",
          lat: d.lat,
          lon: d.lon,
          timestamp: signalDate.toISOString(),
          hour: signalDate.getHours(),
        };

        signals.push(signal);

        // Aggregate by route
        const routeKey = signal.route_name || signal.route_id;
        byRoute.set(routeKey, (byRoute.get(routeKey) || 0) + 1);

        // Aggregate by hour
        const hour = signalDate.getHours();
        if (hour >= 0 && hour < 24) {
          byHour[hour] += 1;
        }

        // Aggregate by location (snap to ~100m grid)
        if (typeof d.lat === "number" && typeof d.lon === "number") {
          const snapLat = Math.round(d.lat * 1000) / 1000;
          const snapLon = Math.round(d.lon * 1000) / 1000;
          const locKey = `${snapLat},${snapLon}`;
          if (!locationBuckets.has(locKey)) {
            locationBuckets.set(locKey, { lat: snapLat, lon: snapLon, count: 0 });
          }
          locationBuckets.get(locKey).count += 1;
        }
      });

      // Convert aggregations to arrays
      const routeBreakdown = Array.from(byRoute.entries())
        .map(([route, count]) => ({ route, count }))
        .sort((a, b) => b.count - a.count);

      const hourlyBreakdown = byHour.map((count, hour) => ({ hour, count }));

      const hotspots = Array.from(locationBuckets.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 20);

      // Find peak hour
      let peakHour = 0;
      let peakCount = 0;
      byHour.forEach((count, hour) => {
        if (count > peakCount) {
          peakCount = count;
          peakHour = hour;
        }
      });

      const payload = {
        signals: signals.slice(0, 100), // Limit to last 100 signals
        summary: {
          total: signals.length,
          byRoute: routeBreakdown,
          byHour: hourlyBreakdown,
          hotspots,
          peakHour: peakCount > 0 ? `${pad2(peakHour)}:00–${pad2((peakHour + 1) % 24)}:00` : "N/A",
          peakHourSignals: peakCount,
        },
        window: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
        },
        filters: {
          line_id: lineId === "all" ? null : lineId,
          direction,
        },
      };

      return res.json(payload);
    } catch (err) {
      console.error("❌ Reports demand error:", err);
      return res.status(500).json({
        error: "demand_report_failed",
        message: err.message || String(err),
      });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /reports/forecast
  // Very lightweight 7-day demand sketch (no prices, just trip counts)
  // Shape: { forecast: Array<{ day, trips }> }
  // ---------------------------------------------------------------------------
  router.get("/forecast", async (_req, res) => {
    try {
      const today = new Date();
      const days = [];

      for (let i = 0; i < 7; i++) {
        const d = new Date(
          today.getFullYear(),
          today.getMonth(),
          today.getDate() + i
        );

        const dow = d.getDay();
        const label = weekdayShort[dow];

        // Tiny sinusoidal pattern just to give admins a sense of weekday vs weekend.
        const baseTrips = 20;
        const bump = 5 * Math.sin((2 * Math.PI * (dow + i)) / 7);
        const expectedTrips = Math.max(5, Math.round(baseTrips + bump));

        days.push({
          day: label,
          trips: expectedTrips,
        });
      }

      return res.json({ forecast: days });
    } catch (err) {
      console.error("❌ Reports forecast error:", err);
      return res.status(500).json({
        error: "forecast_failed",
        message: err.message || String(err),
      });
    }
  });

  return router;
}