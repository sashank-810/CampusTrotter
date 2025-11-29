// backend/src/services/driverNavigationService.js
/**
 * Driver Navigation Service - Full Google Maps Integration
 *
 * Provides turn-by-turn navigation, traffic-aware ETAs, and real-time
 * route updates for drivers on their assigned routes.
 */

const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";
const DISTANCE_MATRIX_URL = "https://maps.googleapis.com/maps/api/distancematrix/json";

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

/**
 * Decode Google's encoded polyline format
 */
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== "string") return [];

  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;
  const coordinates = [];

  while (index < len) {
    let b, shift = 0, result = 0;

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

    coordinates.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return coordinates;
}

/**
 * Get full navigation data from driver's current position to all remaining stops
 * Includes turn-by-turn instructions, traffic-aware ETAs, and polyline
 *
 * @param {Object} params
 * @param {number} params.driverLat - Driver's current latitude
 * @param {number} params.driverLng - Driver's current longitude
 * @param {Array} params.stops - Array of stops [{stop_id, name, lat, lng, sequence}]
 * @param {number} params.currentStopIndex - Index of next stop to visit (0-based)
 * @returns {Object} Navigation data with route, instructions, ETAs
 */
export async function getDriverNavigation({
  driverLat,
  driverLng,
  stops,
  currentStopIndex = 0,
}) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is not set");
  }

  if (!stops || stops.length === 0) {
    return { error: "No stops provided" };
  }

  // Get remaining stops from current position
  const remainingStops = stops.slice(currentStopIndex);
  if (remainingStops.length === 0) {
    return {
      status: "route_complete",
      message: "All stops have been visited"
    };
  }

  const origin = `${driverLat},${driverLng}`;
  const destination = remainingStops[remainingStops.length - 1];
  const destinationStr = `${destination.lat},${destination.lng}`;

  // Build waypoints for intermediate stops
  const intermediateStops = remainingStops.slice(0, -1);
  let waypointsStr = "";
  if (intermediateStops.length > 0) {
    waypointsStr = intermediateStops
      .map((s) => `${s.lat},${s.lng}`)
      .join("|");
  }

  // Build Directions API URL with traffic
  const url = new URL(DIRECTIONS_URL);
  url.searchParams.set("origin", origin);
  url.searchParams.set("destination", destinationStr);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("departure_time", "now"); // Enable traffic data
  url.searchParams.set("traffic_model", "best_guess");
  url.searchParams.set("alternatives", "false");
  url.searchParams.set("key", apiKey);

  if (waypointsStr) {
    url.searchParams.set("waypoints", waypointsStr);
    url.searchParams.set("optimize", "false"); // Keep stop order
  }

  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Google Directions HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.status !== "OK" || !json.routes?.length) {
      throw new Error(`Directions API error: ${json.status}`);
    }

    const route = json.routes[0];
    const legs = route.legs || [];

    // Build comprehensive navigation response
    const navigation = {
      status: "ok",
      summary: route.summary || "",
      warnings: route.warnings || [],

      // Total route info
      total_distance_m: 0,
      total_duration_s: 0,
      total_duration_in_traffic_s: 0,

      // Full polyline for map display
      polyline: [],
      encoded_polyline: route.overview_polyline?.points || "",

      // Per-stop breakdown with turn-by-turn
      legs: [],

      // Next stop quick access
      next_stop: null,
    };

    // Process each leg (driver → stop1 → stop2 → ...)
    legs.forEach((leg, legIndex) => {
      const stopInfo = remainingStops[legIndex] || {};

      const legData = {
        stop_index: currentStopIndex + legIndex,
        stop_id: stopInfo.stop_id,
        stop_name: stopInfo.name || `Stop ${currentStopIndex + legIndex + 1}`,

        // Distance & duration
        distance_m: leg.distance?.value || 0,
        distance_text: leg.distance?.text || "",
        duration_s: leg.duration?.value || 0,
        duration_text: leg.duration?.text || "",
        duration_in_traffic_s: leg.duration_in_traffic?.value || leg.duration?.value || 0,
        duration_in_traffic_text: leg.duration_in_traffic?.text || leg.duration?.text || "",

        // Start/end locations
        start_location: leg.start_location,
        end_location: leg.end_location,
        start_address: leg.start_address,
        end_address: leg.end_address,

        // Turn-by-turn navigation instructions
        steps: (leg.steps || []).map((step, stepIndex) => ({
          instruction: step.html_instructions?.replace(/<[^>]*>/g, "") || "",
          instruction_html: step.html_instructions || "",
          distance_m: step.distance?.value || 0,
          distance_text: step.distance?.text || "",
          duration_s: step.duration?.value || 0,
          duration_text: step.duration?.text || "",
          maneuver: step.maneuver || null,
          start_location: step.start_location,
          end_location: step.end_location,
          polyline: step.polyline?.points
            ? decodePolyline(step.polyline.points)
            : [],
        })),

        // Leg polyline
        polyline: [],
      };

      // Decode step polylines for this leg
      for (const step of leg.steps || []) {
        if (step.polyline?.points) {
          const decoded = decodePolyline(step.polyline.points);
          legData.polyline.push(...decoded);
          navigation.polyline.push(...decoded);
        }
      }

      // Accumulate totals
      navigation.total_distance_m += legData.distance_m;
      navigation.total_duration_s += legData.duration_s;
      navigation.total_duration_in_traffic_s += legData.duration_in_traffic_s;

      navigation.legs.push(legData);

      // Set next stop info (first leg)
      if (legIndex === 0) {
        navigation.next_stop = {
          stop_id: stopInfo.stop_id,
          stop_name: stopInfo.name,
          lat: stopInfo.lat,
          lng: stopInfo.lng,
          distance_m: legData.distance_m,
          distance_text: legData.distance_text,
          eta_seconds: legData.duration_in_traffic_s,
          eta_text: legData.duration_in_traffic_text,
          first_instruction: legData.steps[0]?.instruction || "Proceed to stop",
          maneuver: legData.steps[0]?.maneuver || null,
        };
      }
    });

    // Add formatted totals
    navigation.total_distance_text = formatDistance(navigation.total_distance_m);
    navigation.total_duration_text = formatDuration(navigation.total_duration_s);
    navigation.total_duration_in_traffic_text = formatDuration(navigation.total_duration_in_traffic_s);

    return navigation;

  } catch (err) {
    console.error("[DriverNav] Navigation error:", err?.message || err);
    throw err;
  }
}

/**
 * Get quick ETA update from driver's position to next stop
 * Uses Distance Matrix API for fast, traffic-aware response
 */
export async function getNextStopETA(driverLat, driverLng, nextStopLat, nextStopLng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is not set");
  }

  const url = new URL(DISTANCE_MATRIX_URL);
  url.searchParams.set("origins", `${driverLat},${driverLng}`);
  url.searchParams.set("destinations", `${nextStopLat},${nextStopLng}`);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("departure_time", "now");
  url.searchParams.set("traffic_model", "best_guess");
  url.searchParams.set("key", apiKey);

  try {
    const res = await fetch(url.toString());
    const json = await res.json();

    if (json.status !== "OK") {
      throw new Error(`Distance Matrix error: ${json.status}`);
    }

    const element = json.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") {
      throw new Error(`No route found: ${element?.status}`);
    }

    return {
      distance_m: element.distance?.value || 0,
      distance_text: element.distance?.text || "",
      duration_s: element.duration?.value || 0,
      duration_text: element.duration?.text || "",
      duration_in_traffic_s: element.duration_in_traffic?.value || element.duration?.value || 0,
      duration_in_traffic_text: element.duration_in_traffic?.text || element.duration?.text || "",
    };
  } catch (err) {
    console.error("[DriverNav] ETA error:", err?.message || err);
    throw err;
  }
}

/**
 * Get ETAs to ALL remaining stops from driver's current position
 * Single API call using Distance Matrix
 */
export async function getAllStopsETA(driverLat, driverLng, stops) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_MAPS_API_KEY is not set");
  }

  if (!stops || stops.length === 0) {
    return [];
  }

  const destinations = stops.map((s) => `${s.lat},${s.lng}`).join("|");

  const url = new URL(DISTANCE_MATRIX_URL);
  url.searchParams.set("origins", `${driverLat},${driverLng}`);
  url.searchParams.set("destinations", destinations);
  url.searchParams.set("mode", "driving");
  url.searchParams.set("departure_time", "now");
  url.searchParams.set("traffic_model", "best_guess");
  url.searchParams.set("key", apiKey);

  try {
    const res = await fetch(url.toString());
    const json = await res.json();

    if (json.status !== "OK") {
      throw new Error(`Distance Matrix error: ${json.status}`);
    }

    const elements = json.rows?.[0]?.elements || [];

    return stops.map((stop, idx) => {
      const elem = elements[idx];
      if (!elem || elem.status !== "OK") {
        return {
          stop_id: stop.stop_id,
          stop_name: stop.name,
          error: elem?.status || "NO_DATA",
        };
      }

      return {
        stop_id: stop.stop_id,
        stop_name: stop.name,
        sequence: stop.sequence,
        lat: stop.lat,
        lng: stop.lng,
        distance_m: elem.distance?.value || 0,
        distance_text: elem.distance?.text || "",
        eta_seconds: elem.duration_in_traffic?.value || elem.duration?.value || 0,
        eta_text: elem.duration_in_traffic?.text || elem.duration?.text || "",
      };
    });
  } catch (err) {
    console.error("[DriverNav] All stops ETA error:", err?.message || err);
    throw err;
  }
}

/**
 * Format distance in meters to human readable
 */
function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }
  return `${(meters / 1000).toFixed(1)} km`;
}

/**
 * Format duration in seconds to human readable
 */
function formatDuration(seconds) {
  if (seconds < 60) {
    return `${Math.round(seconds)} sec`;
  }
  const mins = Math.floor(seconds / 60);
  if (mins < 60) {
    return `${mins} min`;
  }
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  return `${hours} hr ${remainingMins} min`;
}
