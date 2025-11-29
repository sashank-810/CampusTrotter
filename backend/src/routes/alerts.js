// backend/src/routes/alerts.js
import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.js";

/**
 * FINAL FIXED VERSION ✅
 * - Ensures every alert has id, target, and createdAt before saving
 * - Guarantees driver-only alerts visible to drivers
 * - Broadcast remains role-safe (no extra duplicates)
 */

export default function alertsRoutes(db, wss) {
  const router = Router();

  // ---------- Helpers ----------
  const normalizeTarget = (t) => {
    if (!t) return "all";
    const s = String(t).toLowerCase().trim();
    if (["user", "users"].includes(s)) return "users";
    if (["driver", "drivers"].includes(s)) return "drivers";
    if (["admin", "admins"].includes(s)) return "admins";
    return "all";
  };

  const normalizeRole = (r) => {
    if (!r) return "unknown";
    const s = String(r).toLowerCase().trim();
    if (["user", "users"].includes(s)) return "user";
    if (["driver", "drivers"].includes(s)) return "driver";
    if (["admin", "admins"].includes(s)) return "admin";
    return "unknown";
  };

  const detectClientRole = (client) => {
    if (!client) return "unknown";
    const possibleKeys = [
      client.userRole,
      client.role,
      client._roleHint,
      client?.user?.role,
      client?.user?.userRole,
      client?.user?.type,
      client?.user?.typeName,
    ];
    for (const key of possibleKeys) {
      if (!key) continue;
      const role = String(key).toLowerCase().trim();
      if (["user", "driver", "admin"].includes(role)) return role;
    }
    return "unknown";
  };

  // ---------- Centralized WebSocket broadcaster ----------
  const broadcastToRole = (payloadObj, target) => {
    if (!wss) return;
    const payload = JSON.stringify({ ...payloadObj, audience: target || "all" });

    const counts = { users: 0, drivers: 0, admins: 0, unknown: 0, total: 0 };

    wss.clients.forEach((client) => {
      try {
        if (!client || client.readyState !== 1) return;
        counts.total++;

        const clientRole = detectClientRole(client);
        if (clientRole === "unknown") {
          counts.unknown++;
          if (target && target !== "all") return;
        }

        const shouldSend =
          target === "all" ||
          (target === "users" && clientRole === "user") ||
          (target === "drivers" && clientRole === "driver") ||
          (target === "admins" && clientRole === "admin");

        if (shouldSend) {
          client.send(payload);
          if (clientRole === "user") counts.users++;
          else if (clientRole === "driver") counts.drivers++;
          else if (clientRole === "admin") counts.admins++;
        }
      } catch (err) {
        console.warn("⚠️ WS per-client send error:", err);
      }
    });

    console.log(
      `📢 Alert broadcasted [target=${target}] → users=${counts.users}, drivers=${counts.drivers}, admins=${counts.admins}, unknown_skipped=${counts.unknown}, total_clients_scanned=${counts.total}`
    );
  };

  // ---------- Create alert ----------
  router.post("/", authenticate, async (req, res) => {
    try {
      const { message, route_id, vehicle_id, type, target } = req.body;
      if (!message) return res.status(400).json({ error: "Message is required" });

      const normalizedTarget = normalizeTarget(target);

      const docRef = db.collection("alerts").doc(); // create first, get id early ✅

      const alert = {
        id: docRef.id, // ✅ ensure Firestore doc always includes ID field
        message,
        route_id: route_id || null,
        vehicle_id: vehicle_id || null,
        type: type || "general",
        target: normalizedTarget || "all", // ✅ ensure target always normalized
        createdAt: new Date().toISOString(), // ✅ consistent ISO time
        resolved: false,
        createdBy: req.user
          ? { email: req.user.email, id: req.user.id, role: req.user.role }
          : null,
      };

      await docRef.set(alert); // save alert with full info

      // Broadcast to correct target audience
      broadcastToRole({ type: "alert_created", data: alert }, alert.target);

      res.json({ ok: true, message: "Alert created successfully", id: docRef.id });
    } catch (err) {
      console.error("❌ Alert creation error:", err);
      res.status(500).json({ error: "Failed to create alert" });
    }
  });

  // ---------- Get alerts (filtered by JWT role) ----------
  router.get("/", authenticate, async (req, res) => {
    try {
      const role = normalizeRole(req.user?.role);
      const snap = await db.collection("alerts").orderBy("createdAt", "desc").limit(100).get();

      const allAlerts = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      const visible = allAlerts.filter((a) => {
        const target = normalizeTarget(a.target);
        return (
          target === "all" ||
          (target === "users" && role === "user") ||
          (target === "drivers" && role === "driver") ||
          (target === "admins" && role === "admin")
        );
      });

      res.json(visible);
    } catch (err) {
      console.error("❌ Alerts fetch error:", err);
      res.status(500).json({ error: "Failed to fetch alerts" });
    }
  });

  // ---------- Delete alert ----------
  router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const snap = await db.collection("alerts").doc(id).get();
      const existing = snap.exists ? snap.data() : null;
      await db.collection("alerts").doc(id).delete();
      const target = existing?.target ? normalizeTarget(existing.target) : "all";
      broadcastToRole({ type: "alert_deleted", data: { id } }, target);
      res.json({ ok: true, message: "Alert deleted successfully" });
    } catch (err) {
      console.error("❌ Alert delete error:", err);
      res.status(500).json({ error: "Failed to delete alert" });
    }
  });

  // ---------- Mark alert resolved ----------
  router.patch("/:id/resolve", authenticate, async (req, res) => {
    try {
      const { id } = req.params;
      const snap = await db.collection("alerts").doc(id).get();
      const existing = snap.exists ? snap.data() : null;
      await db.collection("alerts").doc(id).set({ resolved: true }, { merge: true });
      const target = existing?.target ? normalizeTarget(existing.target) : "all";
      broadcastToRole({ type: "alert_resolved", data: { id } }, target);
      res.json({ ok: true, message: "Alert marked as resolved" });
    } catch (err) {
      console.error("❌ Alert resolve error:", err);
      res.status(500).json({ error: "Failed to mark alert resolved" });
    }
  });

  // ---------- Dev-only test helper ----------
  router.post("/_test", async (req, res) => {
    const { target = "users", message = "Test alert" } = req.body || {};
    const normalizedTarget = normalizeTarget(target);
    const docRef = db.collection("alerts").doc();
    const alert = {
      id: docRef.id,
      message,
      target: normalizedTarget,
      createdAt: new Date().toISOString(),
      resolved: false,
      createdBy: { email: "dev@local", id: "dev" },
    };
    await docRef.set(alert);
    broadcastToRole({ type: "alert_created", data: alert }, normalizedTarget);
    res.json({ ok: true });
  });

  return router;
}
