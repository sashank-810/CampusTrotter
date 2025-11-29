//backend/src/routes/vehicle.js
import { Router } from "express";

export default function vehicleRoutes(db) {
  const router = Router();

  router.get("/", async (_req, res) => {
    try {
      const snap = await db.collection("vehicles").get();
      const vehicles = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      res.json(vehicles);
    } catch (err) {
      console.error("Vehicle list error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const doc = await db.collection("vehicles").doc(id).get();
      if (!doc.exists)
        return res.status(404).json({ error: "Vehicle not found" });
      res.json({ id: doc.id, ...doc.data() });
    } catch (err) {
      console.error("Vehicle get error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/", async (req, res) => {
    try {
      const { vehicle_id, capacity = 4, plateNo } = req.body;
      const newDoc = await db.collection("vehicles").add({
        vehicle_id,
        plateNo: plateNo || vehicle_id,
        capacity,
        occupancy: 0,
        status: "idle",
        createdAt: new Date().toISOString(),
      });
      res.json({ id: newDoc.id });
    } catch (err) {
      console.error("Vehicle create error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      await db.collection("vehicles").doc(id).set(req.body, { merge: true });
      res.json({ ok: true });
    } catch (err) {
      console.error("Vehicle update error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ✅ PATCH for small edits like capacity/status
  router.patch("/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const payload = { ...req.body, updatedAt: new Date().toISOString() };
      await db.collection("vehicles").doc(id).set(payload, { merge: true });
      res.json({ ok: true });
    } catch (err) {
      console.error("Vehicle patch error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ✅ NEW: PATCH /vehicle/:id/capacity — specific capacity update
  router.patch("/:id/capacity", async (req, res) => {
    try {
      const id = req.params.id;
      const { capacity } = req.body;
      if (typeof capacity !== "number" || capacity < 1)
        return res.status(400).json({ error: "Invalid capacity" });
      await db
        .collection("vehicles")
        .doc(id)
        .set({ capacity, updatedAt: new Date().toISOString() }, { merge: true });
      res.json({ ok: true, id, capacity });
    } catch (err) {
      console.error("Vehicle capacity update error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/:id", async (req, res) => {
    try {
      await db.collection("vehicles").doc(req.params.id).delete();
      res.json({ ok: true });
    } catch (err) {
      console.error("Vehicle delete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
}
