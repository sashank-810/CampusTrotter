// backend/src/utils/googleDirections.js
/**
 * Google Directions helper for building road-following polylines
 * between stops.
 *
 * NO haversine, NO straight-line fallback.
 */

const fetch = (...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args));
  
  const DIRECTIONS_BASE =
    "https://maps.googleapis.com/maps/api/directions/json";
  
  /**
   * Decode a Google encoded polyline string into [{ lat, lng }, ...]
   */
  function decodePolyline(encoded) {
    if (!encoded || typeof encoded !== "string") return [];
  
    let index = 0;
    const len = encoded.length;
    let lat = 0;
    let lng = 0;
    const coordinates = [];
  
    while (index < len) {
      let b;
      let shift = 0;
      let result = 0;
  
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
  
      const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      lat += dlat;
  
      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
  
      const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      lng += dlng;
  
      coordinates.push({
        lat: lat / 1e5,
        lng: lng / 1e5,
      });
    }
  
    return coordinates;
  }
  
  /**
   * One Directions call with optional waypoints.
   * We decode **all legs + steps** for maximum road fidelity.
   */
  async function fetchDirectionsPolyline(origin, waypoints, destination) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      throw new Error("GOOGLE_MAPS_API_KEY is not set");
    }
  
    const originStr = `${origin.latitude},${origin.longitude}`;
    const destStr = `${destination.latitude},${destination.longitude}`;
  
    let url = `${DIRECTIONS_BASE}?origin=${encodeURIComponent(
      originStr
    )}&destination=${encodeURIComponent(
      destStr
    )}&mode=driving&key=${encodeURIComponent(
      apiKey
    )}&alternatives=false`;
  
    if (waypoints && waypoints.length) {
      const wp = waypoints
        .map(
          (p) =>
            `via:${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`
        )
        .join("|");
      url += `&waypoints=${encodeURIComponent(wp)}&optimize=false`;
    }
  
    const res = await fetch(url);
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(
        `Google Directions HTTP ${res.status}: ${txt.slice(0, 200)}`
      );
    }
  
    const json = await res.json();
  
    if (json.status !== "OK" || !json.routes || !json.routes.length) {
      throw new Error(
        `Google Directions error: status=${json.status} msg=${json.error_message || "no routes"}`
      );
    }
  
    const route = json.routes[0];
    const legs = route.legs || [];
    const polyPoints = [];
  
    // Decode every step in every leg
    for (const leg of legs) {
      for (const step of leg.steps || []) {
        if (!step.polyline || !step.polyline.points) continue;
        const decoded = decodePolyline(step.polyline.points);
        for (const p of decoded) {
          polyPoints.push({ lat: p.lat, lon: p.lng });
        }
      }
    }
  
    // Fallback to overview polyline only if steps were empty
    if (!polyPoints.length && route.overview_polyline?.points) {
      const decoded = decodePolyline(route.overview_polyline.points);
      return decoded.map((p) => ({ lat: p.lat, lon: p.lng }));
    }
  
    return polyPoints;
  }
  
  /**
   * Build a full route polyline that visits ALL stops in order.
   *
   * Strategy:
   * 1. Try a **single multi-waypoint call** (if within waypoint limits).
   * 2. If that fails, fall back to **pairwise origin→dest calls** between
   *    consecutive stops. Any failing segment is simply skipped.
   *
   * Still: NO haversine, NO straight-line approximation.
   */
  export async function getRoutePolylineForStops(stops) {
    if (!Array.isArray(stops) || stops.length < 2) {
      return [];
    }
  
    const coords = stops
      .map((s) => ({
        latitude: Number(s.location?.latitude),
        longitude: Number(s.location?.longitude),
      }))
      .filter(
        (c) =>
          Number.isFinite(c.latitude) && Number.isFinite(c.longitude)
      );
  
    if (coords.length < 2) {
      return [];
    }
  
    const MAX_WP = 23;
    const allPoints = [];
  
    // 1️⃣ Try single multi-waypoint call when possible
    if (coords.length <= MAX_WP + 2) {
      try {
        const origin = coords[0];
        const destination = coords[coords.length - 1];
        const inner = coords.slice(1, coords.length - 1);
  
        const multi = await fetchDirectionsPolyline(
          origin,
          inner,
          destination
        );
  
        if (multi && multi.length >= 2) {
          return multi;
        }
      } catch (e) {
        console.warn(
          "[Directions] Multi-waypoint call failed, will try pairwise segments:",
          e.message || e
        );
      }
    }
  
    // 2️⃣ Pairwise origin→dest calls: Stop i → Stop i+1
    for (let i = 0; i < coords.length - 1; i++) {
      const origin = coords[i];
      const dest = coords[i + 1];
  
      try {
        const seg = await fetchDirectionsPolyline(origin, [], dest);
        if (!seg || !seg.length) {
          console.warn(
            `[Directions] Empty polyline for segment ${i}→${i + 1}`
          );
          continue;
        }
  
        // Avoid duplicating last point
        if (allPoints.length) {
          const first = seg[0];
          const last = allPoints[allPoints.length - 1];
          if (
            first &&
            last &&
            first.lat === last.lat &&
            first.lon === last.lon
          ) {
            seg.shift();
          }
        }
  
        allPoints.push(...seg);
      } catch (e) {
        console.warn(
          `[Directions] Failed segment ${i}→${i + 1}:`,
          e.message || e
        );
        // Skip this one; do NOT approximate with straight line
      }
    }
  
    return allPoints;
  }
  