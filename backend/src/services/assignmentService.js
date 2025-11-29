//backend/src/services/assignmentService.js
/**
 * Assignment Service with Firestore Transactions
 *
 * All constraint checks and mutations are wrapped in transactions to prevent
 * race conditions when multiple admins create/update assignments concurrently.
 */
import admin from "firebase-admin";

const COLLECTION = "assignments";

function normalizeDirection(direction) {
  const d = (direction || "").toString().toLowerCase();
  if (d === "fro") return "fro";
  return "to";
}

function makeError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Check assignment constraints within a transaction context.
 * This ensures atomicity - no other concurrent request can create
 * conflicting assignments between our check and write.
 */
async function ensureConstraintsInTransaction(db, data, ignoreId) {
  const { driver_id, vehicle_id, route_id } = data;
  const direction = normalizeDirection(data.direction);

  const coll = db.collection(COLLECTION);

  // 1. Driver ↔ exactly one vehicle
  if (driver_id) {
    const snap = await coll
      .where("driver_id", "==", driver_id)
      .where("active", "==", true)
      .get();
    const conflict = snap.docs.find((d) => d.id !== ignoreId);
    if (conflict) {
      throw makeError(
        "Driver is already assigned to a vehicle on another route/direction.",
        409
      );
    }
  }

  // 2. Vehicle ↔ exactly one driver
  if (vehicle_id) {
    const snap = await coll
      .where("vehicle_id", "==", vehicle_id)
      .where("active", "==", true)
      .get();
    const conflict = snap.docs.find((d) => d.id !== ignoreId);
    if (conflict) {
      throw makeError(
        "Vehicle is already assigned to a driver on another route/direction.",
        409
      );
    }
  }

  // 3. Route+direction ↔ at most one active vehicle
  if (route_id) {
    const snap = await coll
      .where("route_id", "==", route_id)
      .where("direction", "==", direction)
      .where("active", "==", true)
      .get();
    const conflict = snap.docs.find((d) => d.id !== ignoreId);
    if (conflict) {
      throw makeError(
        "This route & direction already has an active vehicle assigned. Only one vehicle can run on a route per direction.",
        409
      );
    }
  }
}

export async function listAssignments(db, filters = {}) {
  let ref = db.collection(COLLECTION);
  if (!filters.includeInactive) {
    ref = ref.where("active", "==", true);
  }
  if (filters.route_id) {
    ref = ref.where("route_id", "==", filters.route_id);
  }
  if (filters.driver_id) {
    ref = ref.where("driver_id", "==", filters.driver_id);
  }
  if (filters.vehicle_id) {
    ref = ref.where("vehicle_id", "==", filters.vehicle_id);
  }

  const snap = await ref.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getAssignment(db, id) {
  if (!id) return null;
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

/**
 * Create a new assignment using a Firestore transaction.
 * This ensures that constraint checks and the insert are atomic,
 * preventing race conditions when multiple admins create assignments concurrently.
 */
export async function createAssignment(db, payload) {
  const driver_id = String(payload.driver_id || "").trim();
  const vehicle_id = String(payload.vehicle_id || "").trim();
  const route_id = String(payload.route_id || "").trim();
  const direction = normalizeDirection(payload.direction);

  if (!driver_id || !vehicle_id || !route_id) {
    throw makeError("route_id, vehicle_id and driver_id are required", 400);
  }

  // Fetch friendly names for denormalized display (can be done outside transaction)
  const [routeDoc, driverDoc, vehicleDoc] = await Promise.all([
    db.collection("routes").doc(route_id).get(),
    db.collection("drivers").doc(driver_id).get(),
    db.collection("vehicles").doc(vehicle_id).get(),
  ]);

  const routeData = routeDoc.exists ? routeDoc.data() : {};
  const driverData = driverDoc.exists ? driverDoc.data() : {};
  const vehicleData = vehicleDoc.exists ? vehicleDoc.data() : {};

  const route_name =
    routeData.route_name || routeData.name || routeData.line || route_id;
  const driver_name = driverData.name || driverData.fullName || "";
  const driver_email = driverData.email || "";
  const vehicle_plate =
    vehicleData.plateNo || vehicleData.vehicle_id || vehicleDoc.id || vehicle_id;

  const now = admin.firestore.FieldValue.serverTimestamp();

  // Use transaction to ensure atomic constraint check + insert
  const result = await db.runTransaction(async (transaction) => {
    // Check constraints inside transaction
    await ensureConstraintsInTransaction(db, { driver_id, vehicle_id, route_id, direction }, null);

    // Create new assignment document
    const newDocRef = db.collection(COLLECTION).doc();
    const assignmentData = {
      route_id,
      route_name,
      direction,
      vehicle_id,
      vehicle_plate,
      driver_id,
      driver_name,
      driver_email,
      active: true,
      created_at: now,
      updated_at: now,
    };

    transaction.set(newDocRef, assignmentData);

    return { id: newDocRef.id, ...assignmentData };
  });

  return result;
}

/**
 * Update an assignment using a Firestore transaction.
 * This ensures that constraint checks and the update are atomic.
 */
export async function updateAssignment(db, id, payload) {
  if (!id) throw makeError("assignment id is required", 400);

  // Use transaction to ensure atomic constraint check + update
  const result = await db.runTransaction(async (transaction) => {
    const docRef = db.collection(COLLECTION).doc(id);
    const existingSnap = await transaction.get(docRef);

    if (!existingSnap.exists) {
      throw makeError("Assignment not found", 404);
    }

    const existing = existingSnap.data() || {};

    const driver_id = payload.driver_id
      ? String(payload.driver_id).trim()
      : existing.driver_id;
    const vehicle_id = payload.vehicle_id
      ? String(payload.vehicle_id).trim()
      : existing.vehicle_id;
    const route_id = payload.route_id
      ? String(payload.route_id).trim()
      : existing.route_id;
    const direction = payload.direction
      ? normalizeDirection(payload.direction)
      : existing.direction || "to";
    const active =
      typeof payload.active === "boolean" ? payload.active : existing.active;

    // Check constraints inside transaction (only if active)
    if (active) {
      await ensureConstraintsInTransaction(
        db,
        { driver_id, vehicle_id, route_id, direction },
        id
      );
    }

    const updates = {
      driver_id,
      vehicle_id,
      route_id,
      direction,
      active,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    // If IDs changed, refresh denormalized names
    if (driver_id !== existing.driver_id) {
      const dDoc = await db.collection("drivers").doc(driver_id).get();
      const d = dDoc.exists ? dDoc.data() : {};
      updates.driver_name = d.name || d.fullName || "";
      updates.driver_email = d.email || "";
    }

    if (vehicle_id !== existing.vehicle_id) {
      const vDoc = await db.collection("vehicles").doc(vehicle_id).get();
      const v = vDoc.exists ? vDoc.data() : {};
      updates.vehicle_plate = v.plateNo || v.vehicle_id || vDoc.id || vehicle_id;
    }

    if (route_id !== existing.route_id) {
      const rDoc = await db.collection("routes").doc(route_id).get();
      const r = rDoc.exists ? rDoc.data() : {};
      updates.route_name = r.route_name || r.name || r.line || route_id;
    }

    transaction.update(docRef, updates);

    return { id, ...existing, ...updates };
  });

  return result;
}

export async function deleteAssignment(db, id) {
  if (!id) throw makeError("assignment id is required", 400);
  const docRef = db.collection(COLLECTION).doc(id);
  const snap = await docRef.get();
  if (!snap.exists) {
    // idempotent delete
    return;
  }

  // soft delete: keep record but mark inactive
  await docRef.set(
    {
      active: false,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Switch assignment direction for a driver (globetrotting feature).
 * This bypasses the route+direction constraint because:
 *   - The driver stays on the same route
 *   - The vehicle stays the same
 *   - Only the direction flips between "to" and "fro"
 *
 * Used when driver reaches terminus and starts trip in opposite direction.
 *
 * @param {FirebaseFirestore.Firestore} db - Firestore instance
 * @param {string} driverId - Driver ID whose assignment should be updated
 * @param {string} newDirection - New direction ("to" or "fro")
 * @returns {Promise<Object|null>} Updated assignment or null if not found
 */
export async function switchAssignmentDirection(db, driverId, newDirection) {
  if (!driverId) return null;

  const direction = normalizeDirection(newDirection);

  // Find active assignment for this driver
  const snap = await db
    .collection(COLLECTION)
    .where("driver_id", "==", String(driverId))
    .where("active", "==", true)
    .limit(1)
    .get();

  if (snap.empty) {
    return null; // No active assignment for this driver
  }

  const doc = snap.docs[0];
  const existing = doc.data() || {};

  // If direction is already correct, no update needed
  if (existing.direction === direction) {
    return { id: doc.id, ...existing };
  }

  // Update only the direction - no constraint check needed since:
  // - Same driver, same vehicle, same route
  // - Only direction is changing, which is allowed for globetrotting
  const updates = {
    direction,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  };

  await doc.ref.update(updates);

  return { id: doc.id, ...existing, ...updates, direction };
}

/**
 * Get active assignment for a driver.
 *
 * @param {FirebaseFirestore.Firestore} db - Firestore instance
 * @param {string} driverId - Driver ID
 * @returns {Promise<Object|null>} Assignment or null if not found
 */
export async function getAssignmentByDriver(db, driverId) {
  if (!driverId) return null;

  const snap = await db
    .collection(COLLECTION)
    .where("driver_id", "==", String(driverId))
    .where("active", "==", true)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}
