// backend/src/utils/geo.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROUTE_FILE = path.resolve(__dirname, "../../updated_routes2.json");
let ROUTE_DATA = null;

try {
  ROUTE_DATA = JSON.parse(fs.readFileSync(ROUTE_FILE, "utf8"));
  console.log(`📍 Loaded ${ROUTE_DATA.routes.length} campus routes`);
} catch (err) {
  console.error("❌ Failed to load updated_routes2.json:", err.message);
  ROUTE_DATA = { routes: [] };
}

export function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Return ALL stops for a given route + direction, in order.
 * Mirrors the Firestore structure: route.directions.to / route.directions.fro.
 */
export function getRouteStops(routeId, direction = "to") {
  if (!ROUTE_DATA || !Array.isArray(ROUTE_DATA.routes)) return [];

  const rid = String(routeId);
  const dirKey =
    String(direction).toLowerCase() === "fro" ? "fro" : "to";

  const route = ROUTE_DATA.routes.find(
    (r) => String(r.route_id) === rid
  );

  if (!route || !route.directions) return [];

  const arr = route.directions[dirKey];
  if (!Array.isArray(arr)) return [];

  return arr;
}

export function getAllStops() {
  const stops = [];
  for (const route of ROUTE_DATA.routes || []) {
    for (const dir of ["to", "fro"]) {
      for (const s of route.directions[dir] || []) {
        stops.push({
          stop_name: s.stop_name,
          route_id: route.route_id,
          route_name: route.route_name,
          lat: s.location.latitude,
          lon: s.location.longitude,
        });
      }
    }
  }
  return stops;
}

export function findNearbyStops(lat, lon, radius = 100) {
  const all = getAllStops();
  return all
    .map((s) => ({
      ...s,
      distance: haversine(lat, lon, s.lat, s.lon),
    }))
    .filter((s) => s.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

export function planCampusRoute(originLat, originLon, destLat, destLon) {
  const all = getAllStops();

  const nearestOrigin = all.reduce((min, s) => {
    const d = haversine(originLat, originLon, s.lat, s.lon);
    return !min || d < min.dist ? { stop: s, dist: d } : min;
  }, null);

  const nearestDest = all.reduce((min, s) => {
    const d = haversine(destLat, destLon, s.lat, s.lon);
    return !min || d < min.dist ? { stop: s, dist: d } : min;
  }, null);

  if (!nearestOrigin || !nearestDest) return null;

  if (nearestOrigin.stop.route_id === nearestDest.stop.route_id) {
    return {
      steps: [
        { type: "walk", to: nearestOrigin.stop, distance: nearestOrigin.dist },
        {
          type: "ride",
          route_id: nearestOrigin.stop.route_id,
          route_name: nearestOrigin.stop.route_name,
          from: nearestOrigin.stop,
          to: nearestDest.stop,
        },
        {
          type: "walk",
          to: { lat: destLat, lon: destLon },
          distance: nearestDest.dist,
        },
      ],
    };
  }

  const routeA = all.filter((s) => s.route_id === nearestOrigin.stop.route_id);
  const routeB = all.filter((s) => s.route_id === nearestDest.stop.route_id);

  let transfer = null;
  for (const sa of routeA) {
    for (const sb of routeB) {
      const d = haversine(sa.lat, sa.lon, sb.lat, sb.lon);
      if (d <= 100) {
        transfer = { sa, sb, distance: d };
        break;
      }
    }
    if (transfer) break;
  }

  if (transfer) {
    return {
      steps: [
        { type: "walk", to: nearestOrigin.stop, distance: nearestOrigin.dist },
        {
          type: "ride",
          route_id: nearestOrigin.stop.route_id,
          route_name: nearestOrigin.stop.route_name,
          from: nearestOrigin.stop,
          to: transfer.sa,
        },
        {
          type: "transfer",
          between: [transfer.sa, transfer.sb],
          distance: transfer.distance,
        },
        {
          type: "ride",
          route_id: nearestDest.stop.route_id,
          route_name: nearestDest.stop.route_name,
          from: transfer.sb,
          to: nearestDest.stop,
        },
        {
          type: "walk",
          to: { lat: destLat, lon: destLon },
          distance: nearestDest.dist,
        },
      ],
    };
  }

  return null;
}
