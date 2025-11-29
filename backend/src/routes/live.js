// backend/src/routes/live.js
import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.js";

export default function liveRoutes(db, wss) {
  const router = Router();

  /**
   * GET /live/:routeId
   * Returns ONLY active vehicles on a route (not idle ones)
   *
   * Query params:
   *   - include_idle=true : Also include idle vehicles (for admin view)
   */
  router.get("/:routeId", async (req, res) => {
    try {
      const { routeId } = req.params;
      const includeIdle = req.query.include_idle === "true" || req.query.include_idle === "1";

      const snap = await db.collection("vehicles").where("currentRoute", "==", routeId).get();
      const now = Date.now();
      const TTL = 8 * 60 * 1000;
      const STALE_THRESHOLD = 2 * 60 * 1000; // 2 minutes - consider location stale

      const vehicles = [];

      for (const doc of snap.docs) {
        const v = doc.data();
        const status = v.status || "idle";

        // 🔒 Only show ACTIVE vehicles to users by default
        // Idle vehicles should NOT appear as "moving" on user maps
        if (!includeIdle && status !== "active") {
          continue;
        }

        const demandActive = !!v.demand_high && v.demand_ts && (now - Number(v.demand_ts)) < TTL;

        // Check if location is stale (no update in 2+ minutes)
        const locationTimestamp = v.location?.timestamp || 0;
        const isLocationStale = (now - locationTimestamp) > STALE_THRESHOLD;

        vehicles.push({
          id: doc.id,
          route_id: routeId,
          plateNo: v.plateNo || doc.id,
          status: status,
          direction: v.direction || "to",
          // Only include location if active and not stale
          location: (status === "active" && !isLocationStale)
            ? (v.location || { lat: 0, lng: 0 })
            : null,
          occupancy: v.occupancy ?? 0,
          capacity: v.capacity ?? 12,
          updated_at: locationTimestamp || null,
          is_stale: isLocationStale,
          driver: v.driver_name || v.driver_id || "Unassigned",
          demand_high: demandActive,
        });
      }

      res.json(vehicles);
    } catch (err) {
      console.error("❌ Live route fetch error:", err);
      res.status(500).json({ error: "Failed to fetch live vehicles" });
    }
  });

  router.put("/:vehicleId/capacity", authenticate, requireAdmin, async (req, res) => {
    try {
      const { vehicleId } = req.params;
      const { capacity } = req.body;
      if (!Number.isFinite(capacity) || capacity <= 0)
        return res.status(400).json({ error: "capacity must be a positive number" });

      await db.collection("vehicles").doc(vehicleId).set({ capacity }, { merge: true });

      const payload = JSON.stringify({ type: "vehicle_update", data: { vehicle_id: vehicleId, capacity } });
      wss.clients.forEach(ws => { if (ws.readyState === ws.OPEN) ws.send(payload); });

      res.json({ ok: true });
    } catch (err) {
      console.error("❌ Capacity update error:", err);
      res.status(500).json({ error: "Failed to update capacity" });
    }
  });

  return router;
}
