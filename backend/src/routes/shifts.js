// backend/src/routes/shifts.js
// Driver Shift Management - Track login/logout times, shift duration, breaks

import { Router } from "express";
import admin from "firebase-admin";
import { authenticate, requireAdmin } from "../middleware/auth.js";

const COLLECTION = "driver_shifts";
const BREAKS_COLLECTION = "driver_breaks";

export default function shiftsRoutes(db) {
  const router = Router();

  // ---------------------------------------------------------------------------
  // POST /shifts/clock-in
  // Driver clocks in to start their shift
  // ---------------------------------------------------------------------------
  router.post("/clock-in", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      if (!driverId) {
        return res.status(401).json({ error: "Driver ID not found in token" });
      }

      const { vehicle_id, route_id, lat, lng } = req.body || {};

      // Check if driver already has an active shift
      const activeShift = await db
        .collection(COLLECTION)
        .where("driver_id", "==", driverId)
        .where("status", "==", "active")
        .limit(1)
        .get();

      if (!activeShift.empty) {
        const existing = activeShift.docs[0];
        return res.status(400).json({
          error: "already_clocked_in",
          message: "You already have an active shift",
          shift_id: existing.id,
          clock_in_time: existing.data().clock_in_time,
        });
      }

      // Get driver info
      let driverName = null;
      try {
        const driverSnap = await db.collection("drivers").doc(driverId).get();
        if (driverSnap.exists) {
          driverName = driverSnap.data()?.name || driverSnap.data()?.email;
        }
      } catch {
        // ignore
      }

      // Create new shift
      const now = new Date();
      const shiftData = {
        driver_id: driverId,
        driver_name: driverName,
        vehicle_id: vehicle_id || null,
        route_id: route_id || null,
        clock_in_time: admin.firestore.Timestamp.fromDate(now),
        clock_in_location: lat && lng ? { lat: Number(lat), lng: Number(lng) } : null,
        clock_out_time: null,
        clock_out_location: null,
        status: "active",
        total_break_minutes: 0,
        trips_completed: 0,
        distance_km: 0,
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      };

      const docRef = await db.collection(COLLECTION).add(shiftData);

      // Update driver status
      await db.collection("drivers").doc(driverId).set(
        {
          shift_status: "on_duty",
          current_shift_id: docRef.id,
          last_clock_in: now.toISOString(),
        },
        { merge: true }
      );

      res.json({
        ok: true,
        shift_id: docRef.id,
        clock_in_time: now.toISOString(),
        message: "Successfully clocked in",
      });
    } catch (err) {
      console.error("❌ Clock-in error:", err);
      res.status(500).json({ error: "Failed to clock in" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /shifts/clock-out
  // Driver clocks out to end their shift
  // ---------------------------------------------------------------------------
  router.post("/clock-out", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      if (!driverId) {
        return res.status(401).json({ error: "Driver ID not found in token" });
      }

      const { lat, lng, notes } = req.body || {};

      // Find active shift
      const activeShift = await db
        .collection(COLLECTION)
        .where("driver_id", "==", driverId)
        .where("status", "==", "active")
        .limit(1)
        .get();

      if (activeShift.empty) {
        return res.status(400).json({
          error: "not_clocked_in",
          message: "You don't have an active shift to clock out from",
        });
      }

      const shiftDoc = activeShift.docs[0];
      const shiftData = shiftDoc.data();
      const now = new Date();

      // Calculate shift duration
      const clockInTime = shiftData.clock_in_time.toDate();
      const durationMs = now.getTime() - clockInTime.getTime();
      const durationMinutes = Math.round(durationMs / 60000);
      const workMinutes = durationMinutes - (shiftData.total_break_minutes || 0);

      // End any active breaks
      const activeBreaks = await db
        .collection(BREAKS_COLLECTION)
        .where("shift_id", "==", shiftDoc.id)
        .where("status", "==", "active")
        .get();

      let additionalBreakMinutes = 0;
      for (const breakDoc of activeBreaks.docs) {
        const breakData = breakDoc.data();
        const breakStart = breakData.start_time.toDate();
        const breakDuration = Math.round((now.getTime() - breakStart.getTime()) / 60000);
        additionalBreakMinutes += breakDuration;

        await breakDoc.ref.update({
          end_time: admin.firestore.Timestamp.fromDate(now),
          duration_minutes: breakDuration,
          status: "completed",
        });
      }

      // Update shift
      const updateData = {
        clock_out_time: admin.firestore.Timestamp.fromDate(now),
        clock_out_location: lat && lng ? { lat: Number(lat), lng: Number(lng) } : null,
        status: "completed",
        total_duration_minutes: durationMinutes,
        total_break_minutes: (shiftData.total_break_minutes || 0) + additionalBreakMinutes,
        work_minutes: workMinutes - additionalBreakMinutes,
        notes: notes || null,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      };

      await shiftDoc.ref.update(updateData);

      // Update driver status
      await db.collection("drivers").doc(driverId).set(
        {
          shift_status: "off_duty",
          current_shift_id: null,
          last_clock_out: now.toISOString(),
        },
        { merge: true }
      );

      res.json({
        ok: true,
        shift_id: shiftDoc.id,
        clock_out_time: now.toISOString(),
        total_duration_minutes: durationMinutes,
        work_minutes: workMinutes - additionalBreakMinutes,
        total_break_minutes: (shiftData.total_break_minutes || 0) + additionalBreakMinutes,
        message: "Successfully clocked out",
      });
    } catch (err) {
      console.error("❌ Clock-out error:", err);
      res.status(500).json({ error: "Failed to clock out" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /shifts/break/start
  // Driver starts a break
  // ---------------------------------------------------------------------------
  router.post("/break/start", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      if (!driverId) {
        return res.status(401).json({ error: "Driver ID not found in token" });
      }

      const { reason } = req.body || {};

      // Find active shift
      const activeShift = await db
        .collection(COLLECTION)
        .where("driver_id", "==", driverId)
        .where("status", "==", "active")
        .limit(1)
        .get();

      if (activeShift.empty) {
        return res.status(400).json({
          error: "not_clocked_in",
          message: "You must be clocked in to take a break",
        });
      }

      const shiftDoc = activeShift.docs[0];

      // Check if already on break
      const activeBreak = await db
        .collection(BREAKS_COLLECTION)
        .where("shift_id", "==", shiftDoc.id)
        .where("status", "==", "active")
        .limit(1)
        .get();

      if (!activeBreak.empty) {
        return res.status(400).json({
          error: "already_on_break",
          message: "You are already on a break",
          break_id: activeBreak.docs[0].id,
        });
      }

      // Create break record
      const now = new Date();
      const breakData = {
        shift_id: shiftDoc.id,
        driver_id: driverId,
        start_time: admin.firestore.Timestamp.fromDate(now),
        end_time: null,
        duration_minutes: null,
        reason: reason || "break",
        status: "active",
        created_at: admin.firestore.FieldValue.serverTimestamp(),
      };

      const breakRef = await db.collection(BREAKS_COLLECTION).add(breakData);

      // Update driver status
      await db.collection("drivers").doc(driverId).set(
        { shift_status: "on_break" },
        { merge: true }
      );

      res.json({
        ok: true,
        break_id: breakRef.id,
        start_time: now.toISOString(),
        message: "Break started",
      });
    } catch (err) {
      console.error("❌ Break start error:", err);
      res.status(500).json({ error: "Failed to start break" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /shifts/break/end
  // Driver ends their break
  // ---------------------------------------------------------------------------
  router.post("/break/end", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      if (!driverId) {
        return res.status(401).json({ error: "Driver ID not found in token" });
      }

      // Find active shift
      const activeShift = await db
        .collection(COLLECTION)
        .where("driver_id", "==", driverId)
        .where("status", "==", "active")
        .limit(1)
        .get();

      if (activeShift.empty) {
        return res.status(400).json({
          error: "not_clocked_in",
          message: "You don't have an active shift",
        });
      }

      const shiftDoc = activeShift.docs[0];

      // Find active break
      const activeBreak = await db
        .collection(BREAKS_COLLECTION)
        .where("shift_id", "==", shiftDoc.id)
        .where("status", "==", "active")
        .limit(1)
        .get();

      if (activeBreak.empty) {
        return res.status(400).json({
          error: "not_on_break",
          message: "You are not currently on a break",
        });
      }

      const breakDoc = activeBreak.docs[0];
      const breakData = breakDoc.data();
      const now = new Date();

      // Calculate break duration
      const startTime = breakData.start_time.toDate();
      const durationMinutes = Math.round((now.getTime() - startTime.getTime()) / 60000);

      // Update break record
      await breakDoc.ref.update({
        end_time: admin.firestore.Timestamp.fromDate(now),
        duration_minutes: durationMinutes,
        status: "completed",
      });

      // Update shift total break time
      const shiftData = shiftDoc.data();
      await shiftDoc.ref.update({
        total_break_minutes: (shiftData.total_break_minutes || 0) + durationMinutes,
      });

      // Update driver status
      await db.collection("drivers").doc(driverId).set(
        { shift_status: "on_duty" },
        { merge: true }
      );

      res.json({
        ok: true,
        break_id: breakDoc.id,
        end_time: now.toISOString(),
        duration_minutes: durationMinutes,
        message: "Break ended",
      });
    } catch (err) {
      console.error("❌ Break end error:", err);
      res.status(500).json({ error: "Failed to end break" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /shifts/current
  // Get driver's current shift status
  // ---------------------------------------------------------------------------
  router.get("/current", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      if (!driverId) {
        return res.status(401).json({ error: "Driver ID not found in token" });
      }

      // Find active shift
      const activeShift = await db
        .collection(COLLECTION)
        .where("driver_id", "==", driverId)
        .where("status", "==", "active")
        .limit(1)
        .get();

      if (activeShift.empty) {
        return res.json({
          clocked_in: false,
          shift: null,
          on_break: false,
          current_break: null,
        });
      }

      const shiftDoc = activeShift.docs[0];
      const shiftData = shiftDoc.data();

      // Check for active break
      const activeBreak = await db
        .collection(BREAKS_COLLECTION)
        .where("shift_id", "==", shiftDoc.id)
        .where("status", "==", "active")
        .limit(1)
        .get();

      let currentBreak = null;
      if (!activeBreak.empty) {
        const breakData = activeBreak.docs[0].data();
        currentBreak = {
          break_id: activeBreak.docs[0].id,
          start_time: breakData.start_time.toDate().toISOString(),
          reason: breakData.reason,
          duration_so_far_minutes: Math.round(
            (Date.now() - breakData.start_time.toDate().getTime()) / 60000
          ),
        };
      }

      // Calculate current duration
      const clockInTime = shiftData.clock_in_time.toDate();
      const currentDurationMinutes = Math.round(
        (Date.now() - clockInTime.getTime()) / 60000
      );

      res.json({
        clocked_in: true,
        shift: {
          shift_id: shiftDoc.id,
          clock_in_time: clockInTime.toISOString(),
          vehicle_id: shiftData.vehicle_id,
          route_id: shiftData.route_id,
          current_duration_minutes: currentDurationMinutes,
          total_break_minutes: shiftData.total_break_minutes || 0,
          work_minutes_so_far:
            currentDurationMinutes - (shiftData.total_break_minutes || 0),
          trips_completed: shiftData.trips_completed || 0,
        },
        on_break: !!currentBreak,
        current_break: currentBreak,
      });
    } catch (err) {
      console.error("❌ Get current shift error:", err);
      res.status(500).json({ error: "Failed to get current shift" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /shifts/history
  // Get driver's shift history
  // ---------------------------------------------------------------------------
  router.get("/history", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      if (!driverId) {
        return res.status(401).json({ error: "Driver ID not found in token" });
      }

      const { limit = 20, offset = 0 } = req.query;

      const shiftsSnap = await db
        .collection(COLLECTION)
        .where("driver_id", "==", driverId)
        .orderBy("clock_in_time", "desc")
        .limit(Number(limit))
        .offset(Number(offset))
        .get();

      const shifts = [];
      shiftsSnap.forEach((doc) => {
        const d = doc.data();
        shifts.push({
          shift_id: doc.id,
          clock_in_time: d.clock_in_time?.toDate?.()?.toISOString(),
          clock_out_time: d.clock_out_time?.toDate?.()?.toISOString(),
          status: d.status,
          total_duration_minutes: d.total_duration_minutes,
          work_minutes: d.work_minutes,
          total_break_minutes: d.total_break_minutes,
          trips_completed: d.trips_completed,
          vehicle_id: d.vehicle_id,
          route_id: d.route_id,
        });
      });

      res.json({ shifts, count: shifts.length });
    } catch (err) {
      console.error("❌ Get shift history error:", err);
      res.status(500).json({ error: "Failed to get shift history" });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN: GET /shifts/all
  // Get all shifts (admin only)
  // ---------------------------------------------------------------------------
  router.get("/all", authenticate, requireAdmin, async (req, res) => {
    try {
      const { status, driver_id, from, to, limit = 50 } = req.query;

      let query = db.collection(COLLECTION).orderBy("clock_in_time", "desc");

      if (status) {
        query = query.where("status", "==", status);
      }

      if (driver_id) {
        query = query.where("driver_id", "==", driver_id);
      }

      query = query.limit(Number(limit));

      const snap = await query.get();

      const shifts = [];
      snap.forEach((doc) => {
        const d = doc.data();

        // Filter by date range in memory (avoid composite index)
        if (from || to) {
          const clockIn = d.clock_in_time?.toDate?.();
          if (from && clockIn < new Date(from)) return;
          if (to && clockIn > new Date(to)) return;
        }

        shifts.push({
          shift_id: doc.id,
          driver_id: d.driver_id,
          driver_name: d.driver_name,
          clock_in_time: d.clock_in_time?.toDate?.()?.toISOString(),
          clock_out_time: d.clock_out_time?.toDate?.()?.toISOString(),
          status: d.status,
          total_duration_minutes: d.total_duration_minutes,
          work_minutes: d.work_minutes,
          total_break_minutes: d.total_break_minutes,
          trips_completed: d.trips_completed,
          vehicle_id: d.vehicle_id,
          route_id: d.route_id,
        });
      });

      // Get currently on-duty drivers
      const onDutySnap = await db
        .collection(COLLECTION)
        .where("status", "==", "active")
        .get();

      const onDutyDrivers = [];
      onDutySnap.forEach((doc) => {
        const d = doc.data();
        const clockIn = d.clock_in_time?.toDate?.();
        onDutyDrivers.push({
          shift_id: doc.id,
          driver_id: d.driver_id,
          driver_name: d.driver_name,
          clock_in_time: clockIn?.toISOString(),
          duration_minutes: clockIn
            ? Math.round((Date.now() - clockIn.getTime()) / 60000)
            : 0,
          vehicle_id: d.vehicle_id,
          route_id: d.route_id,
        });
      });

      res.json({
        shifts,
        on_duty_now: onDutyDrivers,
        on_duty_count: onDutyDrivers.length,
      });
    } catch (err) {
      console.error("❌ Get all shifts error:", err);
      res.status(500).json({ error: "Failed to get shifts" });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN: GET /shifts/summary
  // Get shift summary statistics
  // ---------------------------------------------------------------------------
  router.get("/summary", authenticate, requireAdmin, async (req, res) => {
    try {
      const { from, to } = req.query;

      const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const toDate = to ? new Date(to) : new Date();

      const snap = await db
        .collection(COLLECTION)
        .where("status", "==", "completed")
        .orderBy("clock_in_time", "desc")
        .get();

      let totalShifts = 0;
      let totalWorkMinutes = 0;
      let totalBreakMinutes = 0;
      let totalTrips = 0;
      const driverStats = new Map();

      snap.forEach((doc) => {
        const d = doc.data();
        const clockIn = d.clock_in_time?.toDate?.();

        if (clockIn < fromDate || clockIn > toDate) return;

        totalShifts++;
        totalWorkMinutes += d.work_minutes || 0;
        totalBreakMinutes += d.total_break_minutes || 0;
        totalTrips += d.trips_completed || 0;

        // Per-driver stats
        const driverId = d.driver_id;
        if (!driverStats.has(driverId)) {
          driverStats.set(driverId, {
            driver_id: driverId,
            driver_name: d.driver_name,
            shifts: 0,
            work_minutes: 0,
            break_minutes: 0,
            trips: 0,
          });
        }
        const ds = driverStats.get(driverId);
        ds.shifts++;
        ds.work_minutes += d.work_minutes || 0;
        ds.break_minutes += d.total_break_minutes || 0;
        ds.trips += d.trips_completed || 0;
      });

      // Convert to hours
      const avgShiftHours =
        totalShifts > 0
          ? ((totalWorkMinutes + totalBreakMinutes) / totalShifts / 60).toFixed(1)
          : 0;

      const driverSummary = Array.from(driverStats.values())
        .map((ds) => ({
          ...ds,
          work_hours: (ds.work_minutes / 60).toFixed(1),
          break_hours: (ds.break_minutes / 60).toFixed(1),
          avg_shift_hours:
            ds.shifts > 0
              ? ((ds.work_minutes + ds.break_minutes) / ds.shifts / 60).toFixed(1)
              : 0,
        }))
        .sort((a, b) => b.work_minutes - a.work_minutes);

      res.json({
        period: {
          from: fromDate.toISOString(),
          to: toDate.toISOString(),
        },
        totals: {
          shifts: totalShifts,
          work_hours: (totalWorkMinutes / 60).toFixed(1),
          break_hours: (totalBreakMinutes / 60).toFixed(1),
          trips: totalTrips,
          avg_shift_hours: avgShiftHours,
        },
        by_driver: driverSummary,
      });
    } catch (err) {
      console.error("❌ Get shift summary error:", err);
      res.status(500).json({ error: "Failed to get shift summary" });
    }
  });

  return router;
}
