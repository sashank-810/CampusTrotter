// backend/src/routes/pushNotifications.js
// Push notification management routes - FCM token registration and notification preferences

import { Router } from "express";
import admin from "firebase-admin";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import {
  sendPushNotification,
  sendPushNotificationBatch,
  notifyRouteSubscribers,
  notifyAdmins,
  NotificationTypes,
} from "../services/pushNotificationService.js";

export default function pushNotificationRoutes(db) {
  const router = Router();

  // ---------------------------------------------------------------------------
  // POST /notifications/register-token
  // Register FCM token for a user/driver
  // ---------------------------------------------------------------------------
  router.post("/register-token", authenticate, async (req, res) => {
    try {
      const userId = req.user?.uid || req.user?.id;
      const role = req.user?.role || "user";

      if (!userId) {
        return res.status(401).json({ error: "User ID not found in token" });
      }

      const { fcm_token, device_type, device_id } = req.body || {};

      if (!fcm_token) {
        return res.status(400).json({ error: "fcm_token is required" });
      }

      // Determine collection based on role
      const collection = role === "driver" ? "drivers" : role === "admin" ? "admins" : "users";

      // Update user's FCM token
      await db.collection(collection).doc(userId).set(
        {
          fcm_token,
          device_type: device_type || "unknown",
          device_id: device_id || null,
          fcm_updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      console.log(`[FCM] Token registered for ${role} ${userId}`);

      res.json({ ok: true, message: "FCM token registered" });
    } catch (err) {
      console.error("❌ FCM token registration error:", err);
      res.status(500).json({ error: "Failed to register FCM token" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /notifications/subscribe-route
  // Subscribe to notifications for a specific route
  // ---------------------------------------------------------------------------
  router.post("/subscribe-route", authenticate, async (req, res) => {
    try {
      const userId = req.user?.uid || req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "User ID not found" });
      }

      const { route_id, fcm_token } = req.body || {};

      if (!route_id) {
        return res.status(400).json({ error: "route_id is required" });
      }

      // Get user's FCM token if not provided
      let token = fcm_token;
      if (!token) {
        const userSnap = await db.collection("users").doc(userId).get();
        token = userSnap.data()?.fcm_token;
      }

      if (!token) {
        return res.status(400).json({
          error: "no_fcm_token",
          message: "No FCM token found. Please enable notifications first.",
        });
      }

      // Check if already subscribed
      const existingSub = await db
        .collection("push_subscriptions")
        .where("user_id", "==", userId)
        .where("route_id", "==", route_id)
        .limit(1)
        .get();

      if (!existingSub.empty) {
        // Update existing subscription
        await existingSub.docs[0].ref.update({
          fcm_token: token,
          active: true,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        // Create new subscription
        await db.collection("push_subscriptions").add({
          user_id: userId,
          route_id,
          fcm_token: token,
          active: true,
          created_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      res.json({ ok: true, message: `Subscribed to route ${route_id}` });
    } catch (err) {
      console.error("❌ Route subscription error:", err);
      res.status(500).json({ error: "Failed to subscribe to route" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /notifications/unsubscribe-route
  // Unsubscribe from notifications for a specific route
  // ---------------------------------------------------------------------------
  router.post("/unsubscribe-route", authenticate, async (req, res) => {
    try {
      const userId = req.user?.uid || req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "User ID not found" });
      }

      const { route_id } = req.body || {};

      if (!route_id) {
        return res.status(400).json({ error: "route_id is required" });
      }

      // Find and deactivate subscription
      const subs = await db
        .collection("push_subscriptions")
        .where("user_id", "==", userId)
        .where("route_id", "==", route_id)
        .get();

      for (const doc of subs.docs) {
        await doc.ref.update({
          active: false,
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      res.json({ ok: true, message: `Unsubscribed from route ${route_id}` });
    } catch (err) {
      console.error("❌ Route unsubscribe error:", err);
      res.status(500).json({ error: "Failed to unsubscribe from route" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /notifications/subscriptions
  // Get user's route subscriptions
  // ---------------------------------------------------------------------------
  router.get("/subscriptions", authenticate, async (req, res) => {
    try {
      const userId = req.user?.uid || req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "User ID not found" });
      }

      const subs = await db
        .collection("push_subscriptions")
        .where("user_id", "==", userId)
        .where("active", "==", true)
        .get();

      const subscriptions = [];
      subs.forEach((doc) => {
        subscriptions.push({
          id: doc.id,
          route_id: doc.data().route_id,
          created_at: doc.data().created_at?.toDate?.()?.toISOString(),
        });
      });

      res.json({ subscriptions });
    } catch (err) {
      console.error("❌ Get subscriptions error:", err);
      res.status(500).json({ error: "Failed to get subscriptions" });
    }
  });

  // ---------------------------------------------------------------------------
  // GET /notifications/history
  // Get user's notification history
  // ---------------------------------------------------------------------------
  router.get("/history", authenticate, async (req, res) => {
    try {
      const userId = req.user?.uid || req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "User ID not found" });
      }

      const { limit = 20, unread_only } = req.query;

      let query = db
        .collection("user_notifications")
        .where("user_id", "==", userId)
        .orderBy("created_at", "desc")
        .limit(Number(limit));

      if (unread_only === "true") {
        query = query.where("read", "==", false);
      }

      const snap = await query.get();

      const notifications = [];
      snap.forEach((doc) => {
        const d = doc.data();
        notifications.push({
          id: doc.id,
          type: d.type,
          title: d.title,
          body: d.body,
          data: d.data,
          read: d.read,
          created_at: d.created_at?.toDate?.()?.toISOString(),
        });
      });

      // Get unread count
      const unreadSnap = await db
        .collection("user_notifications")
        .where("user_id", "==", userId)
        .where("read", "==", false)
        .count()
        .get();

      res.json({
        notifications,
        unread_count: unreadSnap.data().count,
      });
    } catch (err) {
      console.error("❌ Get notification history error:", err);
      res.status(500).json({ error: "Failed to get notifications" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /notifications/mark-read
  // Mark notifications as read
  // ---------------------------------------------------------------------------
  router.post("/mark-read", authenticate, async (req, res) => {
    try {
      const userId = req.user?.uid || req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: "User ID not found" });
      }

      const { notification_ids, mark_all } = req.body || {};

      if (mark_all) {
        // Mark all unread as read
        const unread = await db
          .collection("user_notifications")
          .where("user_id", "==", userId)
          .where("read", "==", false)
          .get();

        const batch = db.batch();
        unread.forEach((doc) => {
          batch.update(doc.ref, { read: true });
        });
        await batch.commit();

        res.json({ ok: true, marked: unread.size });
      } else if (notification_ids && Array.isArray(notification_ids)) {
        // Mark specific notifications as read
        const batch = db.batch();
        for (const id of notification_ids) {
          const ref = db.collection("user_notifications").doc(id);
          batch.update(ref, { read: true });
        }
        await batch.commit();

        res.json({ ok: true, marked: notification_ids.length });
      } else {
        return res.status(400).json({
          error: "Provide notification_ids array or set mark_all: true",
        });
      }
    } catch (err) {
      console.error("❌ Mark read error:", err);
      res.status(500).json({ error: "Failed to mark notifications as read" });
    }
  });

  // ---------------------------------------------------------------------------
  // ADMIN: POST /notifications/broadcast
  // Send notification to multiple users (admin only)
  // ---------------------------------------------------------------------------
  router.post("/broadcast", authenticate, requireAdmin, async (req, res) => {
    try {
      const { title, body, target, route_id, data } = req.body || {};

      if (!title || !body) {
        return res.status(400).json({ error: "title and body are required" });
      }

      const notification = { title, body, data: data || {} };
      let sentCount = 0;

      if (target === "route" && route_id) {
        // Send to all users subscribed to a route
        await notifyRouteSubscribers(db, route_id, notification);
        sentCount = -1; // Unknown count
      } else if (target === "admins") {
        // Send to all admins
        await notifyAdmins(db, notification);
        sentCount = -1;
      } else if (target === "all") {
        // Send to all users with FCM tokens
        const usersSnap = await db
          .collection("users")
          .where("fcm_token", "!=", null)
          .get();

        const tokens = [];
        usersSnap.forEach((doc) => {
          const token = doc.data()?.fcm_token;
          if (token) tokens.push(token);
        });

        if (tokens.length > 0) {
          const result = await sendPushNotificationBatch(tokens, notification);
          sentCount = result?.successCount || 0;
        }
      } else {
        return res.status(400).json({
          error: 'target must be "route", "admins", or "all"',
        });
      }

      res.json({
        ok: true,
        message: "Broadcast sent",
        sent_count: sentCount,
      });
    } catch (err) {
      console.error("❌ Broadcast error:", err);
      res.status(500).json({ error: "Failed to send broadcast" });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /notifications/test
  // Send a test notification to the current user
  // ---------------------------------------------------------------------------
  router.post("/test", authenticate, async (req, res) => {
    try {
      const userId = req.user?.uid || req.user?.id;
      const role = req.user?.role || "user";

      if (!userId) {
        return res.status(401).json({ error: "User ID not found" });
      }

      // Get user's FCM token
      const collection = role === "driver" ? "drivers" : role === "admin" ? "admins" : "users";
      const userSnap = await db.collection(collection).doc(userId).get();

      if (!userSnap.exists) {
        return res.status(404).json({ error: "User not found" });
      }

      const fcmToken = userSnap.data()?.fcm_token;

      if (!fcmToken) {
        return res.status(400).json({
          error: "no_fcm_token",
          message: "No FCM token registered. Enable notifications first.",
        });
      }

      // Send test notification
      const notification = {
        title: "Test Notification",
        body: "If you see this, push notifications are working!",
        data: { type: "test", timestamp: new Date().toISOString() },
      };

      const result = await sendPushNotification(fcmToken, notification);

      if (result?.error) {
        return res.status(400).json({
          error: "send_failed",
          message: "Failed to send notification. Token may be invalid.",
          details: result,
        });
      }

      res.json({ ok: true, message: "Test notification sent" });
    } catch (err) {
      console.error("❌ Test notification error:", err);
      res.status(500).json({ error: "Failed to send test notification" });
    }
  });

  return router;
}
