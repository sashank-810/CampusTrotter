//backend/src/routes/stops.js
import { Router } from "express";
import { findNearbyStops } from "../utils/geo.js";

export default function stopsRoutes() {
  const router = Router();

  router.get("/nearby", async (req, res) => {
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    const radius = parseFloat(req.query.radius || "100");

    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: "Invalid or missing coordinates" });
    }

    const stops = findNearbyStops(lat, lon, radius);
    res.json({ count: stops.length, stops });
  });

  router.get("/all", async (_req, res) => {
    try {
      const stops = findNearbyStops(13.016, 77.565, 9999999);
      res.json(stops);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
