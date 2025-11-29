//backend/src/routes/assignment.js
import { Router } from "express";
import { authenticate, requireAdmin } from "../middleware/auth.js";
import {
  listAssignments,
  getAssignment,
  createAssignment,
  updateAssignment,
  deleteAssignment,
} from "../services/assignmentService.js";

export default function assignmentRoutes(db) {
  const router = Router();

  // All assignment operations are admin-only
  router.use(authenticate, requireAdmin);

  // GET /assignments
  router.get("/", async (req, res) => {
    try {
      const { route_id, driver_id, vehicle_id, includeInactive } = req.query;
      const filters = {
        route_id: route_id ? String(route_id) : undefined,
        driver_id: driver_id ? String(driver_id) : undefined,
        vehicle_id: vehicle_id ? String(vehicle_id) : undefined,
        includeInactive:
          includeInactive === "true" ||
          includeInactive === "1" ||
          includeInactive === 1,
      };
      const items = await listAssignments(db, filters);
      res.json(items);
    } catch (err) {
      console.error("❌ List assignments error:", err);
      res.status(500).json({ error: "Failed to fetch assignments" });
    }
  });

  // GET /assignments/:id
  router.get("/:id", async (req, res) => {
    try {
      const item = await getAssignment(db, req.params.id);
      if (!item) return res.status(404).json({ error: "Assignment not found" });
      res.json(item);
    } catch (err) {
      console.error("❌ Get assignment error:", err);
      res.status(500).json({ error: "Failed to fetch assignment" });
    }
  });

  // POST /assignments
  router.post("/", async (req, res) => {
    try {
      const assignment = await createAssignment(db, req.body || {});
      res.status(201).json(assignment);
    } catch (err) {
      console.error("❌ Create assignment error:", err);
      const status = err.status || 500;
      res
        .status(status)
        .json({ error: err.message || "Failed to create assignment" });
    }
  });

  // PUT /assignments/:id
  router.put("/:id", async (req, res) => {
    try {
      const assignment = await updateAssignment(db, req.params.id, req.body || {});
      res.json(assignment);
    } catch (err) {
      console.error("❌ Update assignment error:", err);
      const status = err.status || 500;
      res
        .status(status)
        .json({ error: err.message || "Failed to update assignment" });
    }
  });

  // DELETE /assignments/:id  (soft delete: active=false)
  router.delete("/:id", async (req, res) => {
    try {
      await deleteAssignment(db, req.params.id);
      res.json({ ok: true });
    } catch (err) {
      console.error("❌ Delete assignment error:", err);
      const status = err.status || 500;
      res
        .status(status)
        .json({ error: err.message || "Failed to delete assignment" });
    }
  });

  return router;
}
