// db/scripts/seed_rtdb.js
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import fs from "fs";

// Init Firebase Admin
const app = initializeApp({
  credential: applicationDefault(),
  databaseURL: "http://127.0.0.1:9000/?ns=demo-transvahan"
});
const db = getDatabase(app);

// ---- Seed Concurrent Users ----
async function seedConcurrentUsers() {
  const concurrent = JSON.parse(fs.readFileSync("./db/seed/conc_users.json"));
  for (const user of concurrent) {
    await db.ref(`status/${user.userId}`).set({
      state: user.state,
      lastSeen: new Date(user.lastSeen).getTime()
    });
    console.log(`Seeded status for ${user.userId}`);
  }
}

// ---- Seed Seat Status ----
async function seedSeatStatus() {
  const seatData = JSON.parse(fs.readFileSync("./db/seed/seat_status.json"));
  for (const trip of seatData) {
    await db.ref(`seatStatus/${trip.tripId}`).set({
      occupied: trip.occupied,
      capacity: trip.capacity,
      lastUpdated: new Date(trip.lastUpdated).getTime()
    });
    console.log(`Seeded seatStatus for ${trip.tripId}`);
  }
}

// ---- Seed GPS Points ----
async function seedGpsPoints() {
  const gpsData = JSON.parse(fs.readFileSync("./db/seed/gps_points.json"));
  for (const trip of gpsData) {
    for (const point of trip.points) {
      const ts = new Date(point.timestamp).getTime();
      await db.ref(`gps/${trip.tripId}/${ts}`).set({
        lat: point.lat,
        lon: point.lon,
        speed: point.speed
      });
    }
    console.log(`Seeded gps points for ${trip.tripId}`);
  }
}
// ---- Seed Vehicles ----
async function seedVehicles() {
  const vehicles = JSON.parse(fs.readFileSync("./db/seed/vehicles.json"));
  for (const vehicle of vehicles) {
    await db.ref(`vehicles/${vehicle.vehicleId}`).set({
      plateNo: vehicle.plateNo,
      capacity: vehicle.capacity,
      status: vehicle.status,
      currentRoute: vehicle.currentRoute,
      liveLocation: {
        lat: vehicle.liveLocation.lat,
        lon: vehicle.liveLocation.lon,
        updatedAt: new Date(vehicle.liveLocation.updatedAt).getTime()
      }
    });
    console.log(`Seeded vehicle ${vehicle.vehicleId}`);
  }
}

// ---- Main ----
async function main() {
  await seedConcurrentUsers();
  await seedSeatStatus();
  await seedGpsPoints();
  await seedVehicles();
  process.exit(0);
}

main();
