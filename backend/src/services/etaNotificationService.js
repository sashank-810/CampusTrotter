// backend/src/services/etaNotificationService.js
// ETA Notification Service - Monitors approaching shuttles and sends push notifications

import admin from "firebase-admin";
import {
  sendPushNotification,
  NotificationTypes,
} from "./pushNotificationService.js";

// Haversine distance calculation in meters
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius in meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Track which notifications have been sent to avoid duplicates
// Key: `${userId}:${vehicleId}:${stopId}:${threshold}`
const sentNotifications = new Map();

// Cleanup old notification tracking every 10 minutes
setInterval(() => {
  const now = Date.now();
  const TTL = 30 * 60 * 1000; // 30 minutes
  for (const [key, timestamp] of sentNotifications.entries()) {
    if (now - timestamp > TTL) {
      sentNotifications.delete(key);
    }
  }
}, 10 * 60 * 1000);

/**
 * ETA Notification Thresholds (in minutes)
 * Users will be notified at each threshold as the shuttle approaches
 */
const ETA_THRESHOLDS = [5, 2]; // Notify at 5 mins and 2 mins

/**
 * Start the ETA notification monitoring service
 * @param {FirebaseFirestore.Firestore} db - Firestore instance
 * @param {number} intervalMs - Check interval in milliseconds (default: 30 seconds)
 */
export function startETANotificationService(db, intervalMs = 30000) {
  console.log("[ETA Service] Starting ETA notification monitoring...");

  const checkInterval = setInterval(async () => {
    try {
      await checkApproachingShuttles(db);
    } catch (err) {
      console.error("[ETA Service] Error checking shuttles:", err?.message || err);
    }
  }, intervalMs);

  // Return cleanup function
  return () => {
    clearInterval(checkInterval);
    console.log("[ETA Service] Stopped");
  };
}

/**
 * Calculate cumulative route distance from vehicle to a target stop
 * Goes: vehicle → nearest stop → next stop → ... → target stop
 *
 * @param {number} vLat - Vehicle latitude
 * @param {number} vLng - Vehicle longitude
 * @param {Array} stops - Array of route stops in order
 * @param {number} currentStopIndex - Index of the stop vehicle is approaching/at
 * @param {number} targetStopIndex - Index of the target stop
 * @returns {number} - Total distance in meters along the route
 */
function calculateCumulativeRouteDistance(vLat, vLng, stops, currentStopIndex, targetStopIndex) {
  if (targetStopIndex < currentStopIndex) return 0;

  let totalDistance = 0;

  // First segment: vehicle to current/next stop
  const firstStop = stops[currentStopIndex];
  const firstStopLat = firstStop?.lat;
  const firstStopLng = firstStop?.lng || firstStop?.lon;

  if (Number.isFinite(firstStopLat) && Number.isFinite(firstStopLng)) {
    totalDistance += haversineMeters(vLat, vLng, firstStopLat, firstStopLng);
  }

  // Subsequent segments: stop to stop along the route
  for (let i = currentStopIndex; i < targetStopIndex; i++) {
    const fromStop = stops[i];
    const toStop = stops[i + 1];

    const fromLat = fromStop?.lat;
    const fromLng = fromStop?.lng || fromStop?.lon;
    const toLat = toStop?.lat;
    const toLng = toStop?.lng || toStop?.lon;

    if (
      Number.isFinite(fromLat) && Number.isFinite(fromLng) &&
      Number.isFinite(toLat) && Number.isFinite(toLng)
    ) {
      totalDistance += haversineMeters(fromLat, fromLng, toLat, toLng);
    }
  }

  return totalDistance;
}

/**
 * Check all active shuttles and notify users when ETA thresholds are met
 */
async function checkApproachingShuttles(db) {
  // Get all active vehicles
  const vehiclesSnap = await db
    .collection("vehicles")
    .where("status", "==", "active")
    .get();

  if (vehiclesSnap.empty) return;

  // Get all active reservations
  const reservationsSnap = await db
    .collection("reservations")
    .where("status", "==", "confirmed")
    .get();

  if (reservationsSnap.empty) return;

  // Group reservations by route and stop
  const reservationsByRouteStop = new Map();
  reservationsSnap.forEach((doc) => {
    const r = doc.data();
    const key = `${r.route_id}:${r.stop_id}`;
    if (!reservationsByRouteStop.has(key)) {
      reservationsByRouteStop.set(key, []);
    }
    reservationsByRouteStop.get(key).push({ id: doc.id, ...r });
  });

  // Process each active vehicle
  for (const vDoc of vehiclesSnap.docs) {
    const vehicle = vDoc.data();
    const vehicleId = vDoc.id;
    const routeId = vehicle.currentRoute;
    const direction = vehicle.direction || "to";

    if (!routeId) continue;

    const vLat = vehicle.location?.lat;
    const vLng = vehicle.location?.lng || vehicle.location?.lon;

    if (!Number.isFinite(vLat) || !Number.isFinite(vLng)) continue;

    // Get route stops
    const routeSnap = await db.collection("routes").doc(routeId).get();
    if (!routeSnap.exists) continue;

    const routeData = routeSnap.data();
    const routeName = routeData.route_name || routeId;
    const stops = routeData.directions?.[direction] || [];

    // Find vehicle's current position along the route (nearest upcoming stop)
    let closestStopIndex = -1;
    let closestDistance = Infinity;

    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      const stopLat = stop.lat;
      const stopLng = stop.lng || stop.lon;

      if (!Number.isFinite(stopLat) || !Number.isFinite(stopLng)) continue;

      const dist = haversineMeters(vLat, vLng, stopLat, stopLng);
      if (dist < closestDistance) {
        closestDistance = dist;
        closestStopIndex = i;
      }
    }

    if (closestStopIndex < 0) continue;

    // Check upcoming stops for reservations
    for (let i = closestStopIndex; i < stops.length; i++) {
      const stop = stops[i];
      const stopId = stop.stop_id || stop.id || `stop_${i}`;
      const stopName = stop.name || stop.stop_name || `Stop ${i + 1}`;
      const stopLat = stop.lat;
      const stopLng = stop.lng || stop.lon;

      if (!Number.isFinite(stopLat) || !Number.isFinite(stopLng)) continue;

      // Calculate CUMULATIVE ETA: vehicle → stop1 → stop2 → ... → target stop
      // This follows the actual route path, not direct distance
      const cumulativeDistance = calculateCumulativeRouteDistance(
        vLat, vLng, stops, closestStopIndex, i
      );
      const avgSpeedMps = 8; // ~30 km/h average campus shuttle speed
      const etaMinutes = Math.round(cumulativeDistance / avgSpeedMps / 60);

      // Check if we should notify users at this stop
      const key = `${routeId}:${stopId}`;
      const reservations = reservationsByRouteStop.get(key) || [];

      for (const reservation of reservations) {
        await notifyUserIfThresholdMet(
          db,
          reservation,
          vehicleId,
          routeName,
          stopName,
          etaMinutes
        );
      }
    }
  }
}

/**
 * Notify user if ETA threshold is met and notification hasn't been sent yet
 */
async function notifyUserIfThresholdMet(
  db,
  reservation,
  vehicleId,
  routeName,
  stopName,
  etaMinutes
) {
  const userId = reservation.user_id;
  if (!userId) return;

  for (const threshold of ETA_THRESHOLDS) {
    // Check if ETA is at or below threshold
    if (etaMinutes <= threshold) {
      const notifKey = `${userId}:${vehicleId}:${reservation.stop_id}:${threshold}`;

      // Skip if already notified for this threshold
      if (sentNotifications.has(notifKey)) continue;

      // Mark as notified
      sentNotifications.set(notifKey, Date.now());

      // Get user's FCM token
      const userSnap = await db.collection("users").doc(userId).get();
      if (!userSnap.exists) continue;

      const fcmToken = userSnap.data()?.fcm_token;
      if (!fcmToken) continue;

      // Determine notification message
      let notification;
      if (etaMinutes <= 1) {
        notification = {
          title: "Shuttle Arriving Now!",
          body: `Your ${routeName} shuttle is arriving at ${stopName}`,
          data: {
            type: "eta_alert",
            route: routeName,
            stop: stopName,
            eta: "now",
            reservation_id: reservation.id,
          },
        };
      } else {
        notification = NotificationTypes.SHUTTLE_ARRIVING(routeName, etaMinutes);
        notification.body = `Your shuttle will arrive at ${stopName} in ${etaMinutes} min`;
        notification.data.stop = stopName;
        notification.data.reservation_id = reservation.id;
      }

      try {
        await sendPushNotification(fcmToken, notification);
        console.log(
          `[ETA Service] Notified user ${userId}: ${routeName} arriving at ${stopName} in ${etaMinutes} min`
        );

        // Also store in notifications collection for in-app viewing
        await db.collection("user_notifications").add({
          user_id: userId,
          type: "eta_alert",
          title: notification.title,
          body: notification.body,
          data: notification.data,
          read: false,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.error(`[ETA Service] Failed to notify user ${userId}:`, err?.message);
      }

      // Only send one notification per check (most urgent threshold)
      break;
    }
  }
}

/**
 * Manually trigger ETA check for a specific route
 * (Can be called when a vehicle starts a trip)
 */
export async function triggerETACheckForRoute(db, routeId) {
  try {
    console.log(`[ETA Service] Manual check triggered for route ${routeId}`);
    await checkApproachingShuttles(db);
  } catch (err) {
    console.error("[ETA Service] Manual check error:", err?.message || err);
  }
}

/**
 * Notify all users with reservations on a route that trip has started
 */
export async function notifyTripStarted(db, routeId, direction, routeName) {
  try {
    // Get all confirmed reservations for this route
    const reservationsSnap = await db
      .collection("reservations")
      .where("route_id", "==", routeId)
      .where("status", "==", "confirmed")
      .get();

    if (reservationsSnap.empty) return;

    const userTokens = new Map(); // userId -> fcmToken

    for (const doc of reservationsSnap.docs) {
      const r = doc.data();
      if (!r.user_id) continue;

      // Get user's FCM token
      const userSnap = await db.collection("users").doc(r.user_id).get();
      if (!userSnap.exists) continue;

      const fcmToken = userSnap.data()?.fcm_token;
      if (fcmToken) {
        userTokens.set(r.user_id, fcmToken);
      }
    }

    // Send notifications
    const notification = NotificationTypes.TRIP_STARTED(
      routeName || routeId,
      direction
    );

    for (const [userId, fcmToken] of userTokens.entries()) {
      try {
        await sendPushNotification(fcmToken, notification);

        // Store in notifications collection
        await db.collection("user_notifications").add({
          user_id: userId,
          type: "trip_started",
          title: notification.title,
          body: notification.body,
          data: notification.data,
          read: false,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (err) {
        console.error(`[ETA Service] Failed to notify user ${userId} of trip start`);
      }
    }

    console.log(
      `[ETA Service] Notified ${userTokens.size} users of trip start on ${routeName}`
    );
  } catch (err) {
    console.error("[ETA Service] Trip start notification error:", err?.message || err);
  }
}
