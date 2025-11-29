import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { getRoutePolylineForStops } from "../utils/googleDirections.js";

export default function driverAssignmentRoutes(db) {
  const router = Router();

  // GET /driver/assignment
  // Returns the driver's assigned route WITH full route data (stops + polyline)
  // so the driver can see their route highlighted on the map
  router.get("/assignment", authenticate, async (req, res) => {
    try {
      const driverId = req.user?.uid || req.user?.id || req.user?.driver_id;
      if (!driverId) {
        return res.status(400).json({ error: "Invalid driver token" });
      }

      const snap = await db
        .collection("assignments")
        .where("driver_id", "==", driverId)
        .where("active", "==", true)
        .limit(1)
        .get();

      if (snap.empty) {
        return res.json({ assignment: null });
      }

      const doc = snap.docs[0];
      const data = doc.data();
      const routeId = data.route_id;
      const direction = data.direction || "to";

      // Build base assignment response
      const assignment = {
        id: doc.id,
        route_id: routeId,
        route_name: data.route_name,
        vehicle_id: data.vehicle_id,
        vehicle_plate: data.vehicle_plate,
        direction: direction,
        // Will be populated below
        stops: [],
        route_shape: null,
      };

      // Fetch the full route data if route_id exists
      if (routeId) {
        try {
          const routeDoc = await db.collection("routes").doc(routeId).get();
          if (routeDoc.exists) {
            const routeData = routeDoc.data() || {};

            // Get stops for the assigned direction
            const rawStops = routeData.directions?.[direction] || [];
            assignment.stops = rawStops
              .map((s, idx) => ({
                stop_id: s.stop_id || s.id || `stop_${idx}`,
                name: s.name || s.stop_name || `Stop ${idx + 1}`,
                sequence: Number.isFinite(s.sequence) ? s.sequence : idx,
                lat: s.location?.latitude ?? s.lat,
                lng: s.location?.longitude ?? s.lng ?? s.lon,
              }))
              .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
              .sort((a, b) => a.sequence - b.sequence);

            // Get route shape (polyline) - check cache first
            const cachedShape = routeData.shape_cache?.[direction];
            if (cachedShape?.points?.length > 1) {
              assignment.route_shape = {
                points: cachedShape.points,
                from_cache: true,
              };
            } else if (assignment.stops.length >= 2) {
              // Generate polyline if not cached
              try {
                const stopsForPolyline = assignment.stops.map((s) => ({
                  location: { latitude: s.lat, longitude: s.lng },
                }));
                const points = await getRoutePolylineForStops(stopsForPolyline);
                if (points && points.length > 1) {
                  assignment.route_shape = {
                    points: points,
                    from_cache: false,
                  };

                  // Cache the shape for future requests
                  try {
                    const existingCache = routeData.shape_cache || {};
                    existingCache[direction] = {
                      points: points,
                      updated_at: new Date().toISOString(),
                    };
                    await db.collection("routes").doc(routeId).set(
                      { shape_cache: existingCache },
                      { merge: true }
                    );
                  } catch (cacheErr) {
                    console.warn("⚠️ Failed to cache route shape:", cacheErr?.message);
                  }
                }
              } catch (polyErr) {
                console.warn("⚠️ Could not generate route polyline:", polyErr?.message);
              }
            }

            // Include route color if available (for map display)
            if (routeData.color) {
              assignment.route_color = routeData.color;
            }
          }
        } catch (routeErr) {
          console.warn("⚠️ Could not fetch route details:", routeErr?.message);
          // Continue without route details - at least return basic assignment
        }
      }

      return res.json({ assignment });
    } catch (err) {
      console.error("GET /driver/assignment error:", err);
      res.status(500).json({ error: "Failed to fetch assignment" });
    }
  });

  return router;
}