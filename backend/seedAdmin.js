// backend/seedAdmin.js
import admin from "firebase-admin";
import dotenv from "dotenv";
import bcrypt from "bcrypt";

dotenv.config();

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log(`🔥 Using Firestore Emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
  admin.initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID || "",
  });
} else {
  console.log("⚙️ Using live Firestore project");
  admin.initializeApp();
}

const db = admin.firestore();

async function seedAdmin() {
  const email = "admin@transvahan.com";
  const password = "admin123";
  const hashed = await bcrypt.hash(password, 10);

  console.log(`🔑 Seeding admin: ${email}`);

  try {
    const snapshot = await db
      .collection("admins")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      console.log("ℹ️ Admin already exists. Updating password...");
      const doc = snapshot.docs[0];
      await doc.ref.update({ password: hashed });
      console.log("✅ Admin password updated successfully!");
    } else {
      await db.collection("admins").add({
        email,
        password: hashed,
        role: "admin",
        createdAt: new Date().toISOString(),
      });
      console.log("✅ Admin seeded successfully!");
    }
  } catch (err) {
    console.error("❌ Error seeding admin:", err);
  } finally {
    process.exit(0);
  }
}

seedAdmin();