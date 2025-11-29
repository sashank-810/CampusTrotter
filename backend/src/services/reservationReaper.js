// backend/src/services/reservationReaper.js
//
// Periodic "reaper" for stale reservations.
// - Marks old "waiting" reservations as "expired"
// - Recomputes per-stop reservation summary per route+direction
// - Broadcasts `reservation_update` over WebSocket so apps stay in sync

const TTL_MINUTES = 45; // how long a "waiting" reservation can live
const TTL_MS = TTL_MINUTES * 60 * 1000;

/**
 * Small helper to broadcast over WebSocket if the backend
 * exposes `wss` as `globalThis.__transvahan_wss__`.
 */
function broadcastWS(type, data) {
  try {
    const wss = globalThis.__transvahan_wss__;
    if (!wss || !wss.clients) return;
    const payload = JSON.stringify({ type, data });
    wss.clients.forEach((ws) => {
      try {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }
}

/**
 * Compute a lightweight reservation summary (waiting_count per sequence)
 * for a given route + direction.
 */
async function computeLightSummary(db, routeId, direction) {
  const snap = await db
    .collection("reservations")
    .where("route_id", "==", routeId)
    .where("direction", "==", direction)
    .where("status", "==", "waiting")
    .get();

  const bySeq = {};
  snap.forEach((doc) => {
    const r = doc.data() || {};
    const src = Number(r.source_sequence);
    const dst = Number(r.dest_sequence);
    if (!Number.isFinite(src) || !Number.isFinite(dst) || dst <= src) return;

    for (let s = src; s < dst; s++) {
      bySeq[s] = (bySeq[s] || 0) + 1;
    }
  });

  return Object.entries(bySeq).map(([seq, count]) => ({
    sequence: Number(seq),
    waiting_count: Number(count),
  }));
}

/**
 * Main entry: called every few seconds from index.js:
 *   setInterval(() => runReservationReaper(db), 5000);
 */
export async function runReservationReaper(db) {
  if (!db) return;

  const now = Date.now();
  const cutoffIso = new Date(now - TTL_MS).toISOString();

  try {
    // 1) Find stale "waiting" reservations
    const staleSnap = await db
      .collection("reservations")
      .where("status", "==", "waiting")
      .where("created_at", "<", cutoffIso)
      .get();

    if (staleSnap.empty) return;

    const batch = db.batch();
    const touchedRouteDirs = {};

    staleSnap.forEach((doc) => {
      const r = doc.data() || {};
      const route_id = r.route_id;
      const direction = (r.direction || "to").toLowerCase();

      if (!route_id || !["to", "fro"].includes(direction)) return;

      batch.update(doc.ref, {
        status: "expired",
        expired_reason: "timeout",
        expired_at: new Date(now).toISOString(),
        updated_at: new Date(now).toISOString(),
      });

      const key = `${route_id}__${direction}`;
      if (!touchedRouteDirs[key]) {
        touchedRouteDirs[key] = { route_id, direction };
      }
    });

    if (Object.keys(touchedRouteDirs).length === 0) return;

    await batch.commit();

    // 2) For each affected route+direction, recompute summary and broadcast
    for (const key of Object.keys(touchedRouteDirs)) {
      const { route_id, direction } = touchedRouteDirs[key];
      const stops = await computeLightSummary(db, route_id, direction);

      broadcastWS("reservation_update", {
        route_id,
        direction,
        stops,
      });
    }
  } catch (err) {
    console.error(
      "❌ ReservationReaper error:",
      err?.message || err
    );
  }
}
