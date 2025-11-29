// backend/src/routes/feedback.js
import { Router } from "express";

export default function feedbackRoutes(db) {
  const router = Router();

  // ✅ Submit feedback (anonymous)
  router.post("/", async (req, res) => {
    try {
      const { vehicle_id, rating, comment } = req.body || {};

      if (!vehicle_id || typeof rating === "undefined" || rating === null) {
        return res.status(400).json({ error: "Missing fields" });
      }

      const numericRating = Number(rating);
      if (Number.isNaN(numericRating)) {
        return res.status(400).json({ error: "Invalid rating" });
      }

      const feedbackRef = db.collection("feedback").doc();
      const doc = {
        vehicle_id: String(vehicle_id),
        rating: numericRating,
        comment: typeof comment === "string" ? comment.trim() : "",
        timestamp: new Date().toISOString(),
      };

      await feedbackRef.set(doc);
      res.json({ message: "Feedback submitted", id: feedbackRef.id });
    } catch (err) {
      console.error("❌ Feedback error:", err);
      res.status(500).json({ error: "Failed to submit feedback" });
    }
  });

  // ✅ Get feedback for a specific vehicle/line
  router.get("/:vehicle_id", async (req, res) => {
    try {
      const { vehicle_id } = req.params;
      const snapshot = await db
        .collection("feedback")
        .where("vehicle_id", "==", vehicle_id)
        .orderBy("timestamp", "desc")
        .limit(50)
        .get();

      const feedback = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...doc.data(),
      }));

      res.json(feedback);
    } catch (err) {
      console.error("❌ Feedback fetch error:", err);
      res.status(500).json({ error: "Failed to fetch feedback" });
    }
  });

  // ✅ Get *all* feedback for admin reports
  router.get("/", async (_req, res) => {
    try {
      const snapshot = await db
        .collection("feedback")
        .orderBy("timestamp", "desc")
        .limit(100)
        .get();

      const all = snapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));

      res.json(all);
    } catch (err) {
      console.error("❌ Feedback all fetch error:", err);
      res.status(500).json({ error: "Failed to fetch all feedback" });
    }
  });

  return router;
}