//backend/src/controllers/tripController.js
const { getETA } = require('../services/etaService');
const firestore = require('../services/firestore'); // your wrapper; else use admin.firestore()

async function createTrip(req, res) {
  try {
    const {
      origin_lat, origin_lng,
      dest_lat, dest_lng,
      timestamp,          // client provided or server time
      request_type = "pickup",
      line_id,
    } = req.body;

    // 1) Call your router to get distance + RE-ETA (pseudo-code)
    const route = await req.app.locals.routeService.getRoute({
      origin_lat, origin_lng, dest_lat, dest_lng
    });
    const distance_m = route.distance_m;
    const re_eta_seconds = route.eta_seconds;

    // 2) Call ETA microservice
    const etaResp = await getETA({
      origin_lat, origin_lng,
      dest_lat, dest_lng,
      timestamp: Math.floor((timestamp ? new Date(timestamp) : new Date()).getTime() / 1000),
      request_type,
      distance_m,
      re_eta_seconds
    });

    // 3) Persist trip
    const doc = {
      origin: {lat: origin_lat, lng: origin_lng},
      dest:   {lat: dest_lat,   lng: dest_lng},
      created_at: new Date().toISOString(),
      line_id: line_id || null,
      request_type,
      routing: {
        distance_m,
        re_eta_seconds,
      },
      eta: {
        eta_seconds: etaResp.eta_seconds,
        residual_seconds: etaResp.residual_seconds,
        calib_bias_seconds: etaResp.calib_bias_seconds,
      },
      status: "created"
    };

    const saved = await firestore.createTrip(doc); // implement using Firestore
    res.json({ ok: true, trip_id: saved.id, ...doc });

  } catch (e) {
    console.error("createTrip error", e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

module.exports = { createTrip };
