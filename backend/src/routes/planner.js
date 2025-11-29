// backend/src/routes/planner.js
import { Router } from "express";
import { getAllStops, planCampusRoute } from "../utils/geo.js";

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

const fetchFn =
  typeof fetch === "function"
    ? fetch
    : (...args) =>
        import("node-fetch").then(({ default: f }) =>
          f(...args)
        );

export default function plannerRoutes() {
  const router = Router();

  router.get("/plan", async (req, res) => {
    const { fromLat, fromLon, toLat, toLon } = req.query;
    const lat1 = parseFloat(fromLat);
    const lon1 = parseFloat(fromLon);
    const lat2 = parseFloat(toLat);
    const lon2 = parseFloat(toLon);

    if ([lat1, lon1, lat2, lon2].some((x) => isNaN(x))) {
      return res.status(400).json({ error: "Invalid coordinates" });
    }

    const plan = planCampusRoute(lat1, lon1, lat2, lon2);
    if (!plan) return res.status(404).json({ error: "No viable route found" });
    res.json(plan);
  });

  router.get("/search", async (req, res) => {
    const query = (req.query.q || req.query.query || "").trim();
    const limit = Math.min(parseInt(req.query.limit, 10) || 6, 12);
    const biasLat = parseFloat(req.query.lat);
    const biasLon = parseFloat(req.query.lon);

    if (!query) {
      return res.status(400).json({ error: "Missing search query" });
    }

    // 1) Local stop matches (hardcoded routes)
    const allStops = getAllStops();
    const qLower = query.toLowerCase();
    const stopMatches = allStops
      .filter((s) => {
        const name = (s.stop_name || "").toLowerCase();
        const route = (s.route_name || "").toLowerCase();
        return name.includes(qLower) || route.includes(qLower);
      })
      .slice(0, limit)
      .map((s, idx) => ({
        id: s.stop_id || `stop_${idx}_${s.route_id}_${s.stop_name}`,
        name: s.stop_name,
        subtitle: "Campus stop",
        lat: s.lat,
        lon: s.lon,
        source: "stop",
        route_id: s.route_id,
        route_name: s.route_name,
      }))
      .filter(
        (s) =>
          typeof s.lat === "number" &&
          typeof s.lon === "number" &&
          !isNaN(s.lat) &&
          !isNaN(s.lon)
      );

    // 2) Google Places Autocomplete + Details for non-hardcoded landmarks
    let placeResults = [];
    if (!GOOGLE_MAPS_API_KEY) {
      console.warn("⚠️  GOOGLE_MAPS_API_KEY missing; returning stop matches only.");
    } else {
      try {
        const centerLat = !isNaN(biasLat) ? biasLat : 13.0205;
        const centerLon = !isNaN(biasLon) ? biasLon : 77.5655;

        const acUrl = new URL(
          "https://maps.googleapis.com/maps/api/place/autocomplete/json"
        );
        acUrl.searchParams.set("input", query);
        acUrl.searchParams.set("key", GOOGLE_MAPS_API_KEY);
        acUrl.searchParams.set("location", `${centerLat},${centerLon}`);
        acUrl.searchParams.set("radius", "5000");
        acUrl.searchParams.set("types", "establishment");
        acUrl.searchParams.set("components", "country:IN");

        const acResp = await fetchFn(acUrl.toString());
        if (!acResp.ok) {
          const txt = await acResp.text();
          throw new Error(`Google Places Autocomplete HTTP ${acResp.status}: ${txt.slice(0, 200)}`);
        }

        const acJson = await acResp.json();
        if (acJson.status !== "OK" && acJson.status !== "ZERO_RESULTS") {
          throw new Error(
            `Google Places Autocomplete status ${acJson.status}: ${acJson.error_message || "unknown"}`
          );
        }

        const predictions = (acJson.predictions || []).slice(0, limit);

        const detailed = await Promise.all(
          predictions.map(async (p) => {
            try {
              const detUrl = new URL(
                "https://maps.googleapis.com/maps/api/place/details/json"
              );
              detUrl.searchParams.set("place_id", p.place_id);
              detUrl.searchParams.set(
                "fields",
                "name,formatted_address,geometry/location"
              );
              detUrl.searchParams.set("key", GOOGLE_MAPS_API_KEY);

              const detResp = await fetchFn(detUrl.toString());
              if (!detResp.ok) {
                return null;
              }
              const detJson = await detResp.json();
              const loc = detJson.result?.geometry?.location;
              if (
                !loc ||
                typeof loc.lat !== "number" ||
                typeof loc.lng !== "number"
              )
                return null;

              return {
                id: detJson.result?.place_id || p.place_id,
                name: detJson.result?.name || p.description || query,
                subtitle:
                  detJson.result?.formatted_address ||
                  p.description ||
                  "Google Maps",
                lat: loc.lat,
                lon: loc.lng,
                source: "google_place",
                place_id: detJson.result?.place_id || p.place_id,
              };
            } catch {
              return null;
            }
          })
        );

        placeResults = detailed.filter(Boolean).slice(0, limit);
      } catch (err) {
        console.error("❌ Google Places search failed:", err?.message || err);
      }
    }

    const combined = [...placeResults, ...stopMatches];
    res.json({
      query,
      results: combined,
      stops: stopMatches,
      places: placeResults,
    });
  });

  return router;
}
