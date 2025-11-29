// backend/src/routes/admin.js
import express from "express";
import bcrypt from "bcrypt";

export default function adminRoutes(db) {
  const router = express.Router();

  // ----------------------------------------------------
  // DRIVER MANAGEMENT (used by admin portal)
  // ----------------------------------------------------

  // Create driver
  router.post("/drivers", async (req, res) => {
    try {
      const { name, email, password } = req.body;
      if (!email || !password) {
        return res
          .status(400)
          .json({ error: "email & password required" });
      }

      const snap = await db
        .collection("drivers")
        .where("email", "==", email)
        .limit(1)
        .get();

      if (!snap.empty) {
        return res.status(400).json({ error: "Driver exists" });
      }

      const hashed = await bcrypt.hash(password, 10);
      const doc = await db.collection("drivers").add({
        name: name || "",
        email,
        password: hashed,
        createdAt: new Date().toISOString(),
        active: true,
      });

      res.json({ id: doc.id, message: "Driver created" });
    } catch (err) {
      console.error("Create driver error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // List drivers
  router.get("/drivers", async (_req, res) => {
    try {
      const snap = await db.collection("drivers").get();
      const drivers = snap.docs.map((d) => {
        const data = d.data() || {};
        const { password, ...rest } = data; // do not leak hashed password
        return { id: d.id, ...rest };
      });
      res.json(drivers);
    } catch (err) {
      console.error("Admin /drivers error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Delete driver
  router.delete("/drivers/:id", async (req, res) => {
    try {
      await db.collection("drivers").doc(req.params.id).delete();
      res.json({ message: "Driver removed" });
    } catch (err) {
      console.error("Delete driver error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // (Optional) Update driver – matches updateDriver() on frontend
  router.put("/drivers/:id", async (req, res) => {
    try {
      await db
        .collection("drivers")
        .doc(req.params.id)
        .set(req.body, { merge: true });
      res.json({ ok: true });
    } catch (err) {
      console.error("Update driver error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ----------------------------------------------------
  // SIMPLE ANALYTICS
  // ----------------------------------------------------
  router.get("/analytics", async (_req, res) => {
    try {
      const since = new Date();
      since.setDate(since.getDate() - 7);

      const snap = await db
        .collection("driver_activity")
        .where("createdAt", ">=", since.toISOString())
        .get();

      const activities = snap.docs.map((d) => d.data());
      // You can refine these numbers later; keeping your placeholders
      res.json({
        peakUsage: "8-10AM",
        activeDrivers: 5,
        totalActivities: activities.length,
      });
    } catch (err) {
      console.error("Analytics error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ----------------------------------------------------
  // USERS LIST (admin portal)
  // ----------------------------------------------------
  router.get("/users", async (_req, res) => {
    try {
      const snap = await db.collection("users").get();
      res.json(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    } catch (err) {
      console.error("Admin /users error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ----------------------------------------------------
  // Legacy sample: create route (admin-only)
  // (You also have `/routes` in route.js; this is kept as-is)
  // ----------------------------------------------------
  router.post("/routes", async (req, res) => {
    try {
      const { name, stops = [], schedule = {} } = req.body;
      const doc = await db.collection("routes").add({
        name,
        stops,
        schedule,
        createdAt: new Date().toISOString(),
      });
      res.json({ id: doc.id });
    } catch (err) {
      console.error("Admin create route error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
