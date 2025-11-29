// backend/src/routes/driver.js
import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { switchAssignmentDirection } from "../services/assignmentService.js";
import { sendDemandAlertEmail } from "../utils/mailer.js";
import { notifyTripStarted } from "../services/etaNotificationService.js";
import {
  getDriverNavigation,
  getNextStopETA,
  getAllStopsETA,
} from "../services/driverNavigationService.js";

// ------------------------- small geo helper -------------------------
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ------------------------- WS broadcast helper -------------------------
function broadcastWS(wss, type, data) {
  try {
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

// ------------------------- direction inference -------------------------
async function inferDirectionFromStart(db, routeId, lat, lng, radiusMeters = 100) {
  try {
    if (!routeId || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const routeDoc = await db.collection("routes").doc(String(routeId)).get();
    if (!routeDoc.exists) return null;

    const d = routeDoc.data() || {};
    const toStops = Array.isArray(d.directions?.to) ? d.directions.to.slice() : [];
    const froStops = Array.isArray(d.directions?.fro) ? d.directions.fro.slice() : [];

    const sortBySeq = (arr) =>
      arr
        .map((s, i) => ({
          ...s,
          sequence: Number.isFinite(s.sequence) ? Number(s.sequence) : i,
        }))
        .sort((a, b) => a.sequence - b.sequence);

    const toSorted = sortBySeq(toStops);
    const froSorted = sortBySeq(froStops);

    const toFirst = toSorted[0];
    const froFirst = froSorted[0];

    const toLat = Number(toFirst?.location?.latitude);
    const toLng = Number(toFirst?.location?.longitude);
    const froLat = Number(froFirst?.location?.latitude);
    const froLng = Number(froFirst?.location?.longitude);

    if (!Number.isFinite(toLat) || !Number.isFinite(toLng) ||
        !Number.isFinite(froLat) || !Number.isFinite(froLng)) {
      return null;
    }

    const dTo = haversineMeters(lat, lng, toLat, toLng);
    const dFro = haversineMeters(lat, lng, froLat, froLng);

    const nearTo = dTo <= radiusMeters;
    const nearFro = dFro <= radiusMeters;

    if (nearTo && nearFro) {
      return dTo <= dFro ? "to" : "fro"; // choose nearer if both near
    }
    if (nearTo) return "to";
    if (nearFro) return "fro";

    return null; // not near either terminus
  } catch (err) {
    console.error("inferDirectionFromStart error:", err?.message || err);
    return null;
  }
}

// ------------------------- routes -------------------------
export default function driverRoutes(db, wss) {
  const router = Router();

  /**
   * POST /driver/telemetry
   * body: { vehicleId, lat, lng, occupancy?, status?, route_id?, direction? }
   *
   * ⚠️ Only broadcasts location updates when vehicle status is "active".
   * If vehicle is "idle", location is stored but NOT broadcast to users.
   * This prevents users from seeing a "moving" vehicle when the trip hasn't started.
   */
  router.post("/telemetry", authenticate, async (req, res) => {
    try {
      const {
        vehicleId,
        lat,
        lng,
        occupancy,
        status,
        route_id,
        direction,
      } = req.body || {};

      if (!vehicleId || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) {
        return res.status(400).json({ error: "vehicleId, lat, lng required" });
      }

      const vRef = db.collection("vehicles").doc(String(vehicleId));
      const vSnap = await vRef.get();
      const vPrev = vSnap.exists ? (vSnap.data() || {}) : {};

      // Check current vehicle status
      const currentStatus = status || vPrev.status || "idle";
      const isActive = currentStatus === "active";

      const payload = {
        updatedAt: new Date().toISOString(),
      };

      // Only update location if vehicle is active (trip has started)
      // This prevents "moving idle vehicle" issue
      if (isActive) {
        payload.location = {
          lat: Number(lat),
          lng: Number(lng),
          timestamp: Date.now(),
        };
      }

      if (typeof occupancy === "number") payload.occupancy = occupancy;
      if (status) payload.status = String(status);
      if (route_id) payload.currentRoute = String(route_id);
      if (direction === "to" || direction === "fro") payload.direction = direction;

      await vRef.set(payload, { merge: true });

      const merged = { id: vehicleId, ...vPrev, ...payload };

      // 🔒 Only broadcast to users when vehicle is ACTIVE
      // Idle vehicles should not appear as "moving" on user maps
      if (isActive) {
        broadcastWS(wss, "vehicle_update", merged);
        broadcastWS(wss, "vehicle", merged);
      }

      res.json({ ok: true, broadcast: isActive });
    } catch (err) {
      console.error("❌ /driver/telemetry error:", err);
      res.status(500).json({ error: "Failed to store telemetry" });
    }
  });

  /**
   * POST /driver/occupancy
   * body: { vehicleId, delta }
   *
   * Uses Firestore transaction to prevent race conditions when
   * multiple drivers update occupancy simultaneously.
   */
  router.post("/occupancy", authenticate, async (req, res) => {
    try {
      const { vehicleId, delta } = req.body || {};
      if (!vehicleId || !Number.isFinite(Number(delta))) {
        return res.status(400).json({ error: "vehicleId, delta required" });
      }

      const vRef = db.collection("vehicles").doc(String(vehicleId));

      // Use transaction to ensure atomic read-modify-write
      const result = await db.runTransaction(async (transaction) => {
        const vSnap = await transaction.get(vRef);
        if (!vSnap.exists) {
          throw new Error("VEHICLE_NOT_FOUND");
        }

        const v = vSnap.data() || {};
        const capacity = Number(v.capacity ?? 4);
        const occ0 = Number(v.occupancy ?? 0);
        const occ1 = Math.max(0, Math.min(capacity, occ0 + Number(delta)));

        transaction.update(vRef, {
          occupancy: occ1,
          updatedAt: new Date().toISOString(),
        });

        return { vehicle: v, occupancy: occ1, capacity };
      });

      const merged = { id: vehicleId, ...result.vehicle, occupancy: result.occupancy };

      broadcastWS(wss, "vehicle_update", merged);
      broadcastWS(wss, "vehicle", merged);

      res.json({ ok: true, occupancy: result.occupancy, capacity: result.capacity });
    } catch (err) {
      if (err.message === "VEHICLE_NOT_FOUND") {
        return res.status(404).json({ error: "Vehicle not found" });
      }
      console.error("❌ /driver/occupancy error:", err);
      res.status(500).json({ error: "Failed to update occupancy" });
    }
  });

  /**
   * POST /driver/trip
   * body: { vehicleId, action:"start"|"stop", route_id?, lat?, lng?, direction? }
   *
   * ✅ GLOBETROTTING behavior:
   *   - on start: infer direction from GPS vs first stop of to/fro within 100m
   *   - if not near either, fallback to provided direction or existing vehicle.direction
   *   - updates vehicle.direction + status + currentRoute
   *   - ALSO updates the driver's assignment direction (globetrotting feature)
   *   - broadcasts vehicle update AND assignment direction change for real-time sync
   */
  router.post("/trip", authenticate, async (req, res) => {
    try {
      const {
        vehicleId,
        action,
        route_id,
        lat,
        lng,
        direction: dirProvided,
      } = req.body || {};

      if (!vehicleId || !action) {
        return res.status(400).json({ error: "vehicleId and action required" });
      }

      // Get driver ID from auth token
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id || null;

      const vRef = db.collection("vehicles").doc(String(vehicleId));
      const vSnap = await vRef.get();
      const vPrev = vSnap.exists ? (vSnap.data() || {}) : {};

      if (String(action).toLowerCase() === "start") {
        const latNum = Number(lat);
        const lngNum = Number(lng);
        const routeId = route_id || vPrev.currentRoute;

        let inferred = null;
        if (Number.isFinite(latNum) && Number.isFinite(lngNum) && routeId) {
          inferred = await inferDirectionFromStart(db, routeId, latNum, lngNum, 100);
        }

        const dirFinal =
          (dirProvided === "to" || dirProvided === "fro")
            ? dirProvided
            : inferred
              ? inferred
              : (vPrev.direction === "fro" ? "fro" : "to");

        const payload = {
          status: "active",
          currentRoute: routeId ? String(routeId) : (vPrev.currentRoute || null),
          direction: dirFinal,
          updatedAt: new Date().toISOString(),
        };

        if (Number.isFinite(latNum) && Number.isFinite(lngNum)) {
          payload.location = {
            lat: latNum,
            lng: lngNum,
            timestamp: Date.now(),
          };
        }

        await vRef.set(payload, { merge: true });

        const merged = { id: vehicleId, ...vPrev, ...payload };

        // Broadcast vehicle update immediately
        broadcastWS(wss, "vehicle_update", merged);
        broadcastWS(wss, "vehicle", merged);

        // ✅ GLOBETROTTING: Update assignment direction if driver is authenticated
        let assignmentUpdated = null;
        if (driverId) {
          try {
            assignmentUpdated = await switchAssignmentDirection(db, driverId, dirFinal);
            if (assignmentUpdated) {
              // Broadcast assignment direction change for real-time sync to admins and users
              broadcastWS(wss, "assignment_direction_changed", {
                assignment_id: assignmentUpdated.id,
                driver_id: driverId,
                vehicle_id: vehicleId,
                route_id: assignmentUpdated.route_id,
                route_name: assignmentUpdated.route_name,
                direction: dirFinal,
                previous_direction: assignmentUpdated.direction === dirFinal ? dirFinal : (dirFinal === "to" ? "fro" : "to"),
              });
              // Also broadcast generic assignment update for list refreshes
              broadcastWS(wss, "assignment_updated", assignmentUpdated);
            }
          } catch (assignErr) {
            console.warn("⚠️ Failed to update assignment direction:", assignErr?.message || assignErr);
            // Don't fail the trip start if assignment update fails
          }
        }

        // 🔔 Notify users with reservations that trip has started
        if (routeId) {
          notifyTripStarted(db, routeId, dirFinal, routeId).catch((err) => {
            console.warn("⚠️ Failed to send trip start notifications:", err?.message);
          });
        }

        return res.json({
          ok: true,
          action: "start",
          direction: dirFinal,
          assignment_updated: !!assignmentUpdated,
        });
      }

      if (String(action).toLowerCase() === "stop") {
        // Reset occupancy to 0 when trip stops
        const payload = {
          status: "idle",
          occupancy: 0,
          updatedAt: new Date().toISOString(),
        };
        await vRef.set(payload, { merge: true });

        const merged = { id: vehicleId, ...vPrev, ...payload, occupancy: 0 };

        broadcastWS(wss, "vehicle_update", merged);
        broadcastWS(wss, "vehicle", merged);

        return res.json({ ok: true, action: "stop", occupancy: 0 });
      }

      return res.status(400).json({ error: "action must be start or stop" });
    } catch (err) {
      console.error("❌ /driver/trip error:", err);
      res.status(500).json({ error: "Failed to control trip" });
    }
  });

  /**
   * POST /driver/demand
   * body: { vehicle_id, route_id, direction, lat, lon, high }
   *
   * Enhanced to:
   * 1. Store demand signals for long-term reporting
   * 2. Send email alerts to admins for short-term surge management
   * 3. Broadcast real-time updates
   */
  router.post("/demand", authenticate, async (req, res) => {
    try {
      const {
        vehicle_id,
        route_id,
        direction = "to",
        lat,
        lon,
        high = true,
      } = req.body || {};

      if (!vehicle_id || !route_id || !Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) {
        return res.status(400).json({ error: "vehicle_id, route_id, lat, lon required" });
      }

      const ts = Date.now();
      const expiresAt = ts + 10 * 60 * 1000;
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id || null;

      // Fetch additional context for reports and email
      let routeName = route_id;
      let driverName = null;
      let vehiclePlate = vehicle_id;

      try {
        // Get route name
        const routeSnap = await db.collection("routes").doc(String(route_id)).get();
        if (routeSnap.exists) {
          routeName = routeSnap.data()?.route_name || routeSnap.data()?.line || route_id;
        }

        // Get driver name
        if (driverId) {
          const driverSnap = await db.collection("drivers").doc(String(driverId)).get();
          if (driverSnap.exists) {
            driverName = driverSnap.data()?.name || driverSnap.data()?.email || null;
          }
        }

        // Get vehicle plate
        const vehicleSnap = await db.collection("vehicles").doc(String(vehicle_id)).get();
        if (vehicleSnap.exists) {
          vehiclePlate = vehicleSnap.data()?.plateNo || vehicleSnap.data()?.vehicle_id || vehicle_id;
        }
      } catch (contextErr) {
        console.warn("⚠️ Could not fetch full context for demand signal:", contextErr?.message);
      }

      // Store demand signal for reports (long-term planning)
      const demandSignalData = {
        vehicle_id: String(vehicle_id),
        vehicle_plate: vehiclePlate,
        route_id: String(route_id),
        route_name: routeName,
        direction: direction === "fro" ? "fro" : "to",
        driver_id: driverId,
        driver_name: driverName,
        lat: Number(lat),
        lon: Number(lon),
        high: !!high,
        ts,
        timestamp: new Date(ts).toISOString(),
        expires_at: expiresAt,
      };

      await db.collection("demand_signals").add(demandSignalData);

      // Update vehicle's demand status
      await db.collection("vehicles").doc(String(vehicle_id)).set(
        { demand_high: !!high, demand_ts: ts },
        { merge: true }
      );

      // Broadcast real-time update
      broadcastWS(wss, "demand_update", {
        vehicle_id: String(vehicle_id),
        route_id: String(route_id),
        route_name: routeName,
        direction,
        demand_high: !!high,
        lat: Number(lat),
        lon: Number(lon),
        ts,
      });

      // Send email alert to admins (short-term planning)
      // Only send for high demand signals, not when demand clears
      if (high) {
        try {
          // Fetch admin emails
          const adminsSnap = await db.collection("admins").get();
          const adminEmails = [];
          adminsSnap.forEach((doc) => {
            const email = doc.data()?.email;
            if (email) adminEmails.push(email);
          });

          // Send async - don't block response
          sendDemandAlertEmail(adminEmails, {
            vehicle_id: vehiclePlate,
            route_id: String(route_id),
            route_name: routeName,
            direction,
            driver_name: driverName,
            lat: Number(lat),
            lon: Number(lon),
          }).catch((emailErr) => {
            console.error("❌ Demand alert email failed:", emailErr?.message);
          });
        } catch (adminErr) {
          console.warn("⚠️ Could not fetch admin emails:", adminErr?.message);
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("❌ /driver/demand error:", err);
      res.status(500).json({ error: "Failed to create demand signal" });
    }
  });

  // ===========================================================================
  // =============== DRIVER NAVIGATION (Google Maps Integration) ===============
  // ===========================================================================

  /**
   * POST /driver/navigation
   * Get full turn-by-turn navigation from driver's current position
   * to all remaining stops on their assigned route.
   *
   * Body: { lat, lng, current_stop_index? }
   *
   * Returns:
   * - Full polyline for map display
   * - Turn-by-turn instructions for each leg
   * - Traffic-aware ETAs to each stop
   * - Next stop details with first instruction
   */
  router.post("/navigation", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      if (!driverId) {
        return res.status(400).json({ error: "Invalid driver token" });
      }

      const { lat, lng, current_stop_index = 0 } = req.body || {};

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: "lat and lng are required" });
      }

      // Get driver's active assignment
      const assignSnap = await db
        .collection("assignments")
        .where("driver_id", "==", driverId)
        .where("active", "==", true)
        .limit(1)
        .get();

      if (assignSnap.empty) {
        return res.status(404).json({ error: "No active assignment found" });
      }

      const assignment = assignSnap.docs[0].data();
      const routeId = assignment.route_id;
      const direction = assignment.direction || "to";

      // Get route stops
      const routeDoc = await db.collection("routes").doc(routeId).get();
      if (!routeDoc.exists) {
        return res.status(404).json({ error: "Assigned route not found" });
      }

      const routeData = routeDoc.data() || {};
      const rawStops = routeData.directions?.[direction] || [];

      const stops = rawStops
        .map((s, idx) => ({
          stop_id: s.stop_id || s.id || `stop_${idx}`,
          name: s.name || s.stop_name || `Stop ${idx + 1}`,
          sequence: Number.isFinite(s.sequence) ? s.sequence : idx,
          lat: s.location?.latitude ?? s.lat,
          lng: s.location?.longitude ?? s.lng ?? s.lon,
        }))
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
        .sort((a, b) => a.sequence - b.sequence);

      if (stops.length === 0) {
        return res.status(400).json({ error: "No valid stops on route" });
      }

      // Get navigation from Google Maps
      const navigation = await getDriverNavigation({
        driverLat: lat,
        driverLng: lng,
        stops,
        currentStopIndex: current_stop_index,
      });

      return res.json({
        route_id: routeId,
        route_name: assignment.route_name,
        route_color: routeData.color || null,
        direction,
        ...navigation,
      });
    } catch (err) {
      console.error("❌ /driver/navigation error:", err);
      res.status(500).json({ error: "Failed to get navigation" });
    }
  });

  /**
   * POST /driver/next-stop-eta
   * Quick ETA update to the next stop (lightweight, traffic-aware)
   *
   * Body: { lat, lng, next_stop_lat, next_stop_lng }
   * OR: { lat, lng } (will auto-detect next stop from assignment)
   */
  router.post("/next-stop-eta", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      const { lat, lng, next_stop_lat, next_stop_lng } = req.body || {};

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: "lat and lng are required" });
      }

      let targetLat = next_stop_lat;
      let targetLng = next_stop_lng;
      let stopName = "Next Stop";

      // If next stop not provided, find it from assignment
      if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) {
        const assignSnap = await db
          .collection("assignments")
          .where("driver_id", "==", driverId)
          .where("active", "==", true)
          .limit(1)
          .get();

        if (assignSnap.empty) {
          return res.status(404).json({ error: "No active assignment" });
        }

        const assignment = assignSnap.docs[0].data();
        const routeDoc = await db.collection("routes").doc(assignment.route_id).get();

        if (!routeDoc.exists) {
          return res.status(404).json({ error: "Route not found" });
        }

        const routeData = routeDoc.data() || {};
        const direction = assignment.direction || "to";
        const stops = routeData.directions?.[direction] || [];

        // Find nearest upcoming stop
        let nearestStop = null;
        let nearestDist = Infinity;

        for (const s of stops) {
          const sLat = s.location?.latitude ?? s.lat;
          const sLng = s.location?.longitude ?? s.lng ?? s.lon;
          if (!Number.isFinite(sLat) || !Number.isFinite(sLng)) continue;

          const dist = haversineMeters(lat, lng, sLat, sLng);
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestStop = { ...s, lat: sLat, lng: sLng };
          }
        }

        if (!nearestStop) {
          return res.status(400).json({ error: "No stops found on route" });
        }

        targetLat = nearestStop.lat;
        targetLng = nearestStop.lng;
        stopName = nearestStop.name || nearestStop.stop_name || "Next Stop";
      }

      const eta = await getNextStopETA(lat, lng, targetLat, targetLng);

      return res.json({
        stop_name: stopName,
        stop_lat: targetLat,
        stop_lng: targetLng,
        ...eta,
      });
    } catch (err) {
      console.error("❌ /driver/next-stop-eta error:", err);
      res.status(500).json({ error: "Failed to get ETA" });
    }
  });

  /**
   * POST /driver/all-stops-eta
   * Get ETAs to ALL remaining stops on the route
   *
   * Body: { lat, lng, current_stop_index? }
   */
  router.post("/all-stops-eta", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      const { lat, lng, current_stop_index = 0 } = req.body || {};

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: "lat and lng are required" });
      }

      // Get assignment
      const assignSnap = await db
        .collection("assignments")
        .where("driver_id", "==", driverId)
        .where("active", "==", true)
        .limit(1)
        .get();

      if (assignSnap.empty) {
        return res.status(404).json({ error: "No active assignment" });
      }

      const assignment = assignSnap.docs[0].data();
      const routeDoc = await db.collection("routes").doc(assignment.route_id).get();

      if (!routeDoc.exists) {
        return res.status(404).json({ error: "Route not found" });
      }

      const routeData = routeDoc.data() || {};
      const direction = assignment.direction || "to";
      const rawStops = routeData.directions?.[direction] || [];

      const stops = rawStops
        .map((s, idx) => ({
          stop_id: s.stop_id || s.id || `stop_${idx}`,
          name: s.name || s.stop_name || `Stop ${idx + 1}`,
          sequence: Number.isFinite(s.sequence) ? s.sequence : idx,
          lat: s.location?.latitude ?? s.lat,
          lng: s.location?.longitude ?? s.lng ?? s.lon,
        }))
        .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
        .sort((a, b) => a.sequence - b.sequence)
        .slice(current_stop_index);

      if (stops.length === 0) {
        return res.json({ stops: [], message: "All stops completed" });
      }

      const stopsWithETA = await getAllStopsETA(lat, lng, stops);

      return res.json({
        route_id: assignment.route_id,
        route_name: assignment.route_name,
        direction,
        stops: stopsWithETA,
      });
    } catch (err) {
      console.error("❌ /driver/all-stops-eta error:", err);
      res.status(500).json({ error: "Failed to get ETAs" });
    }
  });

  return router;
}