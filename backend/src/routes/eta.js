import { Router } from "express";
import {
  getETAGeo,
  getETAGeoAlongRoute,
} from "../services/etaService.js";

/**
 * ETA routes
 *
 * POST /eta/stop
 * Body:
 *  {
 *    route_id: string,
 *    stop_id: string,
 *    direction?: "to" | "fro",
 *    vehicle_label?: string,
 *    current_lat: number,
 *    current_lon: number,
 *    target_lat: number,
 *    target_lon: number
 *  }
 *
 * Returns the ETA service response plus a few mirrored fields.
 */
export default function etaRoutes(/* db (unused for now) */) {
  const router = Router();

  // Shortest-path ETA (existing behaviour)
  router.post("/stop", async (req, res) => {
    try {
      const {
        route_id,
        stop_id,
        direction = "to",
        vehicle_label,
        current_lat,
        current_lon,
        target_lat,
        target_lon,
      } = req.body || {};

      if (
        !route_id ||
        !stop_id ||
        typeof current_lat !== "number" ||
        typeof current_lon !== "number" ||
        typeof target_lat !== "number" ||
        typeof target_lon !== "number"
      ) {
        return res.status(400).json({
          error:
            "route_id, stop_id, current_lat, current_lon, target_lat, target_lon are required",
        });
      }

      // JS getDay(): 0=Sun..6=Sat → Python weekday(): 0=Mon..6=Sun
      const jsDay = new Date().getDay();
      const dow = (jsDay + 6) % 7;
      const hour = new Date().getHours();

      // We still build a payload including these fields; Google Maps ignores them.
      const payload = {
        current_lat,
        current_lon,
        target_lat,
        target_lon,
        route_id: String(route_id),
        stop_id: String(stop_id),
        speed_mps: 6.0,
        delta_t_from_start_s: 300.0,
        baseline_eta_s: 220.0,
        hour_bin: hour,
        dow,
        vehicle_label: vehicle_label || null,
      };

      const etaRes = await getETAGeo(payload);

      return res.json({
        ...etaRes,
        route_id: String(route_id),
        stop_id: String(stop_id),
        direction,
        vehicle_label: vehicle_label || null,
      });
    } catch (err) {
      console.error("❌ ETA /stop error:", err);
      res.status(500).json({
        error: "Failed to compute ETA",
        details: err?.message || String(err),
      });
    }
  });

  /**
   * Route-aware ETA: follow the campus route via intermediate stops.
   *
   * Same body as /eta/stop, but uses Google Directions with via: waypoints.
   */
  router.post("/stop-along-route", async (req, res) => {
    try {
      const {
        route_id,
        stop_id,
        direction = "to",
        vehicle_label,
        current_lat,
        current_lon,
        target_lat,
        target_lon,
      } = req.body || {};

      if (
        !route_id ||
        !stop_id ||
        typeof current_lat !== "number" ||
        typeof current_lon !== "number" ||
        typeof target_lat !== "number" ||
        typeof target_lon !== "number"
      ) {
        return res.status(400).json({
          error:
            "route_id, stop_id, current_lat, current_lon, target_lat, target_lon are required",
        });
      }

      const jsDay = new Date().getDay();
      const dow = (jsDay + 6) % 7;
      const hour = new Date().getHours();

      const payload = {
        current_lat,
        current_lon,
        target_lat,
        target_lon,
        route_id: String(route_id),
        stop_id: String(stop_id),
        speed_mps: 6.0,
        delta_t_from_start_s: 300.0,
        baseline_eta_s: 220.0,
        hour_bin: hour,
        dow,
        vehicle_label: vehicle_label || null,
        direction,
      };

      const etaRes = await getETAGeoAlongRoute(payload);

      return res.json({
        ...etaRes,
        route_id: String(route_id),
        stop_id: String(stop_id),
        direction,
        vehicle_label: vehicle_label || null,
      });
    } catch (err) {
      console.error("❌ ETA /stop-along-route error:", err);
      res.status(500).json({
        error: "Failed to compute route-aware ETA",
        details: err?.message || String(err),
      });
    }
  });

  return router;
}
