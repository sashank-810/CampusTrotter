// backend/src/services/pushNotificationService.js
// Firebase Cloud Messaging (FCM) Push Notification Service
import admin from "firebase-admin";

/**
 * Send push notification to a single device
 * @param {string} token - FCM device token
 * @param {Object} notification - { title, body, data? }
 * @returns {Promise<Object>} - FCM response
 */
export async function sendPushNotification(token, notification) {
  if (!token) {
    console.warn("[FCM] No token provided, skipping notification");
    return null;
  }

  const message = {
    token,
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: notification.data || {},
    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "shuttle_alerts",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          badge: 1,
        },
      },
    },
  };

  try {
    const response = await admin.messaging().send(message);
    console.log(`[FCM] Notification sent: ${response}`);
    return response;
  } catch (err) {
    console.error("[FCM] Send error:", err?.message || err);
    // Handle invalid tokens
    if (
      err?.code === "messaging/invalid-registration-token" ||
      err?.code === "messaging/registration-token-not-registered"
    ) {
      return { error: "invalid_token", code: err.code };
    }
    throw err;
  }
}

/**
 * Send push notification to multiple devices
 * @param {string[]} tokens - Array of FCM device tokens
 * @param {Object} notification - { title, body, data? }
 * @returns {Promise<Object>} - FCM batch response
 */
export async function sendPushNotificationBatch(tokens, notification) {
  if (!tokens || tokens.length === 0) {
    console.warn("[FCM] No tokens provided for batch, skipping");
    return null;
  }

  // Filter out empty tokens
  const validTokens = tokens.filter((t) => t && typeof t === "string");
  if (validTokens.length === 0) {
    return null;
  }

  const message = {
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: notification.data || {},
    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "shuttle_alerts",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          badge: 1,
        },
      },
    },
    tokens: validTokens,
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(
      `[FCM] Batch sent: ${response.successCount} success, ${response.failureCount} failed`
    );

    // Collect failed tokens for cleanup
    const failedTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const err = resp.error;
        if (
          err?.code === "messaging/invalid-registration-token" ||
          err?.code === "messaging/registration-token-not-registered"
        ) {
          failedTokens.push(validTokens[idx]);
        }
      }
    });

    return {
      successCount: response.successCount,
      failureCount: response.failureCount,
      failedTokens,
    };
  } catch (err) {
    console.error("[FCM] Batch send error:", err?.message || err);
    throw err;
  }
}

/**
 * Send notification to all users subscribed to a route
 * @param {FirebaseFirestore.Firestore} db - Firestore instance
 * @param {string} routeId - Route ID
 * @param {Object} notification - { title, body, data? }
 */
export async function notifyRouteSubscribers(db, routeId, notification) {
  try {
    // Get all users subscribed to this route
    const subsSnap = await db
      .collection("push_subscriptions")
      .where("route_id", "==", routeId)
      .where("active", "==", true)
      .get();

    if (subsSnap.empty) {
      console.log(`[FCM] No subscribers for route ${routeId}`);
      return;
    }

    const tokens = [];
    subsSnap.forEach((doc) => {
      const token = doc.data()?.fcm_token;
      if (token) tokens.push(token);
    });

    if (tokens.length > 0) {
      const result = await sendPushNotificationBatch(tokens, notification);

      // Clean up invalid tokens
      if (result?.failedTokens?.length > 0) {
        await cleanupInvalidTokens(db, result.failedTokens);
      }
    }
  } catch (err) {
    console.error("[FCM] Route notification error:", err?.message || err);
  }
}

/**
 * Send notification to a specific user by user ID
 * @param {FirebaseFirestore.Firestore} db - Firestore instance
 * @param {string} userId - User ID
 * @param {Object} notification - { title, body, data? }
 */
export async function notifyUser(db, userId, notification) {
  try {
    const userSnap = await db.collection("users").doc(userId).get();
    if (!userSnap.exists) {
      console.warn(`[FCM] User ${userId} not found`);
      return;
    }

    const fcmToken = userSnap.data()?.fcm_token;
    if (!fcmToken) {
      console.warn(`[FCM] User ${userId} has no FCM token`);
      return;
    }

    const result = await sendPushNotification(fcmToken, notification);

    // Clean up invalid token
    if (result?.error === "invalid_token") {
      await db.collection("users").doc(userId).update({ fcm_token: null });
    }
  } catch (err) {
    console.error("[FCM] User notification error:", err?.message || err);
  }
}

/**
 * Send notification to all admins
 * @param {FirebaseFirestore.Firestore} db - Firestore instance
 * @param {Object} notification - { title, body, data? }
 */
export async function notifyAdmins(db, notification) {
  try {
    const adminsSnap = await db.collection("admins").get();

    const tokens = [];
    adminsSnap.forEach((doc) => {
      const token = doc.data()?.fcm_token;
      if (token) tokens.push(token);
    });

    if (tokens.length > 0) {
      await sendPushNotificationBatch(tokens, notification);
    }
  } catch (err) {
    console.error("[FCM] Admin notification error:", err?.message || err);
  }
}

/**
 * Clean up invalid FCM tokens from database
 * @param {FirebaseFirestore.Firestore} db - Firestore instance
 * @param {string[]} invalidTokens - Array of invalid tokens
 */
async function cleanupInvalidTokens(db, invalidTokens) {
  if (!invalidTokens || invalidTokens.length === 0) return;

  try {
    const batch = db.batch();
    let count = 0;

    // Check users collection
    for (const token of invalidTokens) {
      const usersSnap = await db
        .collection("users")
        .where("fcm_token", "==", token)
        .limit(1)
        .get();

      usersSnap.forEach((doc) => {
        batch.update(doc.ref, { fcm_token: null });
        count++;
      });

      // Check push_subscriptions collection
      const subsSnap = await db
        .collection("push_subscriptions")
        .where("fcm_token", "==", token)
        .get();

      subsSnap.forEach((doc) => {
        batch.update(doc.ref, { active: false });
        count++;
      });
    }

    if (count > 0) {
      await batch.commit();
      console.log(`[FCM] Cleaned up ${count} invalid token references`);
    }
  } catch (err) {
    console.error("[FCM] Token cleanup error:", err?.message || err);
  }
}

/**
 * Notification types for easy use
 */
export const NotificationTypes = {
  SHUTTLE_ARRIVING: (routeName, eta) => ({
    title: "Shuttle Arriving Soon",
    body: `${routeName} shuttle will arrive in ${eta} minutes`,
    data: { type: "eta_alert", route: routeName, eta: String(eta) },
  }),

  SHUTTLE_DELAYED: (routeName, delay) => ({
    title: "Shuttle Delayed",
    body: `${routeName} shuttle is delayed by ${delay} minutes`,
    data: { type: "delay_alert", route: routeName, delay: String(delay) },
  }),

  HIGH_DEMAND: (routeName, location) => ({
    title: "High Demand Alert",
    body: `High passenger demand on ${routeName} route`,
    data: { type: "demand_alert", route: routeName, location },
  }),

  TRIP_STARTED: (routeName, direction) => ({
    title: "Trip Started",
    body: `${routeName} (${direction.toUpperCase()}) has started`,
    data: { type: "trip_started", route: routeName, direction },
  }),

  RESERVATION_CONFIRMED: (routeName, stopName) => ({
    title: "Reservation Confirmed",
    body: `Your seat on ${routeName} at ${stopName} is confirmed`,
    data: { type: "reservation_confirmed", route: routeName, stop: stopName },
  }),

  EMERGENCY: (message) => ({
    title: "Emergency Alert",
    body: message,
    data: { type: "emergency", priority: "high" },
  }),
};
