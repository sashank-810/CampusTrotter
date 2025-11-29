import fetch from "node-fetch";
import { getRouteStops, haversine } from "../utils/geo.js";

const ETA_BASE = process.env.ETA_SERVICE_URL || "http://localhost:8000"; // legacy ML service
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Legacy: Call the structured-feature ETA endpoint (/predict_eta) on the ML service.
 */
export async function getETA(payload) {
  const res = await fetch(`${ETA_BASE}/predict_eta`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ETA service error ${res.status}: ${txt}`);
  }
  return await res.json();
}

/**
 * New implementation: use Google Maps Distance Matrix API to compute ETA.
 * This is the **shortest path** ETA (does NOT follow the campus route).
 */
export async function getETAGeo(payload) {
  const {
    current_lat,
    current_lon,
    target_lat,
    target_lon,
    route_id,
    stop_id,
    vehicle_label,
  } = payload || {};

  if (
    typeof current_lat !== "number" ||
    typeof current_lon !== "number" ||
    typeof target_lat !== "number" ||
    typeof target_lon !== "number"
  ) {
    throw new Error("Invalid coordinates for Google Maps ETA");
  }

  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error(
      "GOOGLE_MAPS_API_KEY is not set in backend environment variables"
    );
  }

  try {
    const origin = `${current_lat},${current_lon}`;
    const destination = `${target_lat},${target_lon}`;

    const url = new URL(
      "https://maps.googleapis.com/maps/api/distancematrix/json"
    );
    url.searchParams.set("origins", origin);
    url.searchParams.set("destinations", destination);
    url.searchParams.set("mode", "driving");
    url.searchParams.set("key", GOOGLE_MAPS_API_KEY);

    const res = await fetch(url.toString());

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(
        `Google Maps ETA HTTP ${res.status}: ${txt.slice(0, 500)}`
      );
    }

    const json = await res.json();

    if (json.status !== "OK") {
      throw new Error(
        `Google Maps ETA API status ${json.status}: ${
          json.error_message || "no error_message"
        }`
      );
    }

    const row = json.rows?.[0];
    const elem = row?.elements?.[0];

    if (!elem || elem.status !== "OK") {
      throw new Error(
        `Google Maps ETA element status ${elem?.status || "UNKNOWN"}`
      );
    }

    const distanceMeters = elem.distance?.value ?? null; // meters
    const durationSeconds = elem.duration?.value ?? null; // seconds

    const nowSeconds = Math.floor(Date.now() / 1000);
    const arrivalTimestampUtc =
      durationSeconds != null ? nowSeconds + durationSeconds : null;

    return {
      // Core ETA
      eta_seconds: durationSeconds,
      eta_s: durationSeconds,
      eta_minutes: durationSeconds != null ? durationSeconds / 60 : null,

      // Arrival time
      arrival_timestamp_utc: arrivalTimestampUtc,

      // Distance
      distance_meters: distanceMeters,
      distance_m: distanceMeters,
      distance_text: elem.distance?.text ?? null,

      // Extra context
      status: json.status,
      origin,
      destination,
      provider: "google_maps_distance_matrix",

      // Useful for debugging
      route_id,
      stop_id,
      vehicle_label: vehicle_label || null,
    };
  } catch (err) {
    console.error("❌ Google Maps ETA fetch failed:", err);
    throw new Error(
      `Google Maps ETA failed: ${err?.message || String(err)}`
    );
  }
}

/**
 * Route-aware ETA:
 * Use Google Directions with **via: waypoints** that follow the campus route
 * between the bus's current position and the target stop.
 *
 * This ensures:
 *  - ETA(TMC) ≥ ETA(Sarvam) when the shuttle must pass intermediate stops
 *  - Google is forced to visit stops in the correct order.
 */
export async function getETAGeoAlongRoute(payload) {
  const {
    current_lat,
    current_lon,
    target_lat,
    target_lon,
    route_id,
    stop_id,
    vehicle_label,
    direction = "to",
  } = payload || {};

  if (!GOOGLE_MAPS_API_KEY) {
    throw new Error(
      "GOOGLE_MAPS_API_KEY is not set in backend environment variables"
    );
  }

  if (
    typeof current_lat !== "number" ||
    typeof current_lon !== "number" ||
    typeof target_lat !== "number" ||
    typeof target_lon !== "number"
  ) {
    throw new Error("Invalid coordinates for Google Maps ETA (along route)");
  }

  // If we don't know the route / stop, fall back to shortest-path ETA.
  if (!route_id || !stop_id) {
    return getETAGeo(payload);
  }

  try {
    const dirKey =
      String(direction).toLowerCase() === "fro" ? "fro" : "to";

    const stops = getRouteStops(String(route_id), dirKey);

    if (!stops || !stops.length) {
      console.warn(
        "[ETA along-route] No stops found for route, falling back to shortest path."
      );
      return getETAGeo(payload);
    }

    // Find the target stop in the route definition.
    const targetIdx = stops.findIndex(
      (s) =>
        String(s.stop_id || s.id) === String(stop_id)
    );

    if (targetIdx === -1) {
      console.warn(
        "[ETA along-route] target stop not found in route, falling back."
      );
      return getETAGeo(payload);
    }

    const targetStop = stops[targetIdx];

    // Find the nearest stop *up to* that target index, based on bus position.
    let nearestIdx = 0;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let i = 0; i <= targetIdx; i++) {
      const s = stops[i];
      const lat =
        s.location?.latitude ?? s.lat;
      const lon =
        s.location?.longitude ?? s.lon;

      if (
        typeof lat !== "number" ||
        typeof lon !== "number"
      ) {
        continue;
      }

      const d = haversine(current_lat, current_lon, lat, lon);
      if (d < bestDist) {
        bestDist = d;
        nearestIdx = i;
      }
    }

    // Build via-waypoints for all intermediate stops between nearestIdx and targetIdx.
    const startIdx = Math.min(nearestIdx + 1, targetIdx);
    const viaStops = [];

    for (let i = startIdx; i < targetIdx; i++) {
      const s = stops[i];
      const lat =
        s.location?.latitude ?? s.lat;
      const lon =
        s.location?.longitude ?? s.lon;
      if (
        typeof lat === "number" &&
        typeof lon === "number"
      ) {
        viaStops.push({ lat, lon });
      }
    }

    const origin = `${current_lat},${current_lon}`;

    const destLat =
      targetStop.location?.latitude ?? target_lat;
    const destLon =
      targetStop.location?.longitude ?? target_lon;
    const destination = `${destLat},${destLon}`;

    const url = new URL(
      "https://maps.googleapis.com/maps/api/directions/json"
    );
    url.searchParams.set("origin", origin);
    url.searchParams.set("destination", destination);
    url.searchParams.set("mode", "driving");
    url.searchParams.set("key", GOOGLE_MAPS_API_KEY);
    url.searchParams.set("departure_time", "now");
    url.searchParams.set("alternatives", "false");

    if (viaStops.length) {
      const wp = viaStops
        .map(
          (p) =>
            `via:${p.lat.toFixed(6)},${p.lon.toFixed(6)}`
        )
        .join("|");
      url.searchParams.set("waypoints", wp);
      url.searchParams.set("optimize", "false");
    }

    const res = await fetch(url.toString());

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(
        `Google Directions HTTP ${res.status}: ${txt.slice(0, 500)}`
      );
    }

    const json = await res.json();

    if (json.status !== "OK" || !json.routes?.length) {
      throw new Error(
        `Google Directions status ${json.status}: ${
          json.error_message || "no routes"
        }`
      );
    }

    const route = json.routes[0];
    const legs = route.legs || [];

    let totalSeconds = 0;
    let totalMeters = 0;

    for (const leg of legs) {
      const dur =
        leg.duration_in_traffic || leg.duration;
      const dist = leg.distance;

      if (dur?.value) totalSeconds += dur.value;
      if (dist?.value) totalMeters += dist.value;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const arrivalTimestampUtc =
      totalSeconds != null ? nowSeconds + totalSeconds : null;

    return {
      eta_seconds: totalSeconds,
      eta_s: totalSeconds,
      eta_minutes:
        totalSeconds != null ? totalSeconds / 60 : null,

      arrival_timestamp_utc: arrivalTimestampUtc,

      distance_meters: totalMeters,
      distance_m: totalMeters,
      distance_text: totalMeters
        ? `${(totalMeters / 1000).toFixed(2)} km`
        : null,

      status: json.status,
      origin,
      destination,
      provider: "google_maps_directions_along_route",

      route_id,
      stop_id,
      vehicle_label: vehicle_label || null,

      // for debugging
      waypoints_count: viaStops.length,
    };
  } catch (err) {
    console.error("❌ Google Maps ETA along-route failed:", err);
    // If anything goes wrong, degrade gracefully to the simple ETA.
    return getETAGeo(payload);
  }
}
