// backend/src/routes/notifications.js
import { Router } from "express";

export default function notificationsRoutes(db) {
  const router = Router();

  // create alert (admin)
  router.post("/", async (req, res) => {
    const { message, level = "info", target = "all" } = req.body;
    const doc = await db.collection("alerts").add({ message, level, target, createdAt: new Date().toISOString() });
    res.json({ id: doc.id });
  });

  // list alerts (latest first)
  router.get("/", async (req, res) => {
    const snap = await db.collection("alerts").orderBy("createdAt", "desc").limit(50).get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });

  return router;
}
