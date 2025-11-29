// backend/src/routes/auth.js
import { Router } from "express";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import bcrypt from "bcrypt";
import {
  loginRateLimiter,
  signupRateLimiter,
  otpRateLimiter,
  passwordResetRateLimiter,
  trackSuspiciousActivity,
} from "../middleware/rateLimiter.js";

export default function authRoutes(db) {
  const router = Router();

  // =========================================================
  // =============== EMAIL CONFIGURATION =====================
  // =========================================================
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });

  // =========================================================
  // =============== SECURITY HELPERS ========================
  // =========================================================
  const getJwtSecret = () => {
    const s = process.env.JWT_SECRET?.trim();
    // In production, refuse to run without a real secret.
    if (!s) throw new Error("JWT_SECRET missing in env");
    return s;
  };

  // Bcrypt cost (default 10)
  const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

  const normEmail = (e) => (e || "").toString().trim().toLowerCase();

  // =========================================================
  // =============== USER SIGNUP =============================
  // =========================================================
  router.post("/signup", signupRateLimiter, async (req, res) => {
    try {
      const { email, name, password, passwordHash } = req.body;

      if (passwordHash) {
        return res.status(400).json({
          error: "Do not send passwordHash. Send plaintext password over HTTPS.",
        });
      }

      const emailNorm = normEmail(email);
      const nameNorm = (name || "").toString().trim();

      if (!emailNorm || !nameNorm || !password) {
        return res
          .status(400)
          .json({ error: "email, name, and password are required" });
      }

      // prevent leaking passwords in logs
      console.log("📥 /auth/signup:", emailNorm);

      const userRef = db.collection("users").doc(emailNorm);
      const existing = await userRef.get();
      if (existing.exists) {
        return res.status(400).json({ error: "User already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const otp = Math.floor(100000 + Math.random() * 900000).toString();

      await userRef.set({
        email: emailNorm,
        name: nameNorm,
        passwordHash: hashedPassword,
        role: "user",
        verified: false,
        otp,
        createdAt: new Date().toISOString(),
      });

      if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: emailNorm,
          subject: "Transvahan OTP Verification",
          text: `Your OTP is ${otp}`,
        });
      } else {
        console.log(`📩 OTP for ${emailNorm}: ${otp} (email not configured)`);
      }

      return res.json({ message: "User registered. Please verify OTP." });
    } catch (err) {
      console.error("Signup error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================
  // =============== VERIFY OTP ==============================
  // =========================================================
  router.post("/verify-otp", otpRateLimiter, async (req, res) => {
    const { email, otp } = req.body;
    try {
      const emailNorm = normEmail(email);

      const userRef = db.collection("users").doc(emailNorm);
      const snap = await userRef.get();
      if (!snap.exists)
        return res.status(400).json({ error: "User not found" });

      if (snap.data().otp !== otp)
        return res.status(400).json({ error: "Invalid OTP" });

      await userRef.update({ verified: true, otp: null });
      console.log(`✅ OTP verified for ${emailNorm}`);
      return res.json({ message: "OTP verified. You can now login." });
    } catch (err) {
      console.error("Verify OTP error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================
  // =============== FORGOT PASSWORD (SEND OTP) ==============
  // =========================================================

  // very small in-memory rate limiter (per server instance)
  const RESET_RATE = new Map();
  const RESET_COOLDOWN_MS = 60 * 1000; // 1 min between requests
  const RESET_MAX_PER_HOUR = 5; // max 5 OTPs/hour per email
  const RESET_WINDOW_MS = 60 * 60 * 1000;

  function canSendReset(emailNorm) {
    const now = Date.now();
    const entry =
      RESET_RATE.get(emailNorm) || { lastSent: 0, count: 0, windowStart: now };

    // reset window
    if (now - entry.windowStart > RESET_WINDOW_MS) {
      entry.windowStart = now;
      entry.count = 0;
    }

    // cooldown
    if (now - entry.lastSent < RESET_COOLDOWN_MS) return false;

    // hourly cap
    if (entry.count >= RESET_MAX_PER_HOUR) return false;

    entry.lastSent = now;
    entry.count += 1;
    RESET_RATE.set(emailNorm, entry);
    return true;
  }

  router.post("/forgot-password", passwordResetRateLimiter, async (req, res) => {
    try {
      const emailNorm = normEmail(req.body.email);

      // Always return generic success to prevent email fishing
      const genericOk = () =>
        res.json({
          message:
            "If an account with that email exists, a reset code has been sent.",
        });

      if (!emailNorm) return genericOk();

      if (!canSendReset(emailNorm)) {
        // still generic to avoid leaking existence
        return genericOk();
      }

      const userRef = db.collection("users").doc(emailNorm);
      const snap = await userRef.get();
      if (!snap.exists) return genericOk();

      const user = snap.data();
      if (!user?.verified) return genericOk();

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpHash = await bcrypt.hash(otp, BCRYPT_ROUNDS);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

      await userRef.update({
        resetOtpHash: otpHash,
        resetOtpExpiresAt: expiresAt,
        resetOtpUsedAt: null,
      });

      if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        await transporter.sendMail({
          from: process.env.EMAIL_USER,
          to: emailNorm,
          subject: "Transvahan Password Reset Code",
          text: `Your password reset OTP is ${otp}. It expires in 15 minutes.`,
        });
      } else {
        console.log(
          `📩 RESET OTP for ${emailNorm}: ${otp} (email not configured)`
        );
      }

      return genericOk();
    } catch (err) {
      console.error("Forgot password error:", err);
      // still generic
      return res.json({
        message:
          "If an account with that email exists, a reset code has been sent.",
      });
    }
  });

  // =========================================================
  // =============== RESET PASSWORD (VERIFY OTP) =============
  // =========================================================
  router.post("/reset-password", passwordResetRateLimiter, async (req, res) => {
    try {
      const emailNorm = normEmail(req.body.email);
      const { otp, newPassword, confirmPassword, passwordHash } = req.body;

      if (passwordHash) {
        return res.status(400).json({
          error: "Do not send passwordHash. Send plaintext password over HTTPS.",
        });
      }
      if (!emailNorm || !otp || !newPassword) {
        return res.status(400).json({ error: "Missing fields." });
      }
      if (confirmPassword !== undefined && newPassword !== confirmPassword) {
        return res.status(400).json({ error: "Passwords do not match." });
      }
      if (newPassword.length < 6) {
        return res
          .status(400)
          .json({ error: "Password must be at least 6 chars." });
      }

      const userRef = db.collection("users").doc(emailNorm);
      const snap = await userRef.get();
      if (!snap.exists) {
        return res.status(400).json({ error: "Invalid OTP or expired." });
      }

      const user = snap.data();
      const exp = user.resetOtpExpiresAt
        ? new Date(user.resetOtpExpiresAt).getTime()
        : 0;
      if (!user.resetOtpHash || !exp || Date.now() > exp) {
        return res.status(400).json({ error: "Invalid OTP or expired." });
      }

      const ok = await bcrypt.compare(otp.toString(), user.resetOtpHash);
      if (!ok) {
        return res.status(400).json({ error: "Invalid OTP or expired." });
      }

      const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

      await userRef.update({
        passwordHash: newHash,
        resetOtpHash: null,
        resetOtpExpiresAt: null,
        resetOtpUsedAt: new Date().toISOString(),
      });

      return res.json({ message: "Password reset successful. Please login." });
    } catch (err) {
      console.error("Reset password error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================
  // =============== USER LOGIN ==============================
  // =========================================================
  router.post("/login", loginRateLimiter, async (req, res) => {
    const { email, password, passwordHash } = req.body;
    try {
      if (passwordHash) {
        trackSuspiciousActivity(req, "Attempted to send passwordHash");
        return res.status(400).json({
          error: "Do not send passwordHash. Send plaintext password over HTTPS.",
        });
      }

      const emailNorm = normEmail(email);
      if (!emailNorm || !password) {
        return res
          .status(400)
          .json({ error: "Email and password are required" });
      }

      const userRef = db.collection("users").doc(emailNorm);
      const snap = await userRef.get();
      if (!snap.exists)
        return res.status(400).json({ error: "User not found" });

      const user = snap.data();
      if (!user.verified)
        return res.status(403).json({ error: "User not verified" });

      const match = await bcrypt.compare(password, user.passwordHash);
      if (!match)
        return res.status(403).json({ error: "Invalid credentials" });

      // ✅ Correct user token (no adminDoc copy-paste)
      const token = jwt.sign(
        {
          id: snap.id,
          email: emailNorm,
          role: user.role || "user",
          name: user.name,
        },
        getJwtSecret(),
        { expiresIn: "7d" }
      );

      console.log(`✅ User ${emailNorm} logged in`);
      return res.json({
        token,
        user: { email: emailNorm, name: user.name, role: user.role },
      });
    } catch (err) {
      console.error("Login error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================
  // =============== ADMIN LOGIN =============================
  // =========================================================
  router.post("/admin/login", loginRateLimiter, async (req, res) => {
    const { email, password, passwordHash } = req.body;

    try {
      if (passwordHash) {
        trackSuspiciousActivity(req, "Attempted to send passwordHash to admin login");
        return res.status(400).json({
          error: "Do not send passwordHash. Send plaintext password over HTTPS.",
        });
      }

      const emailNorm = normEmail(email);
      if (!emailNorm || !password) {
        return res
          .status(400)
          .json({ error: "Email and password are required" });
      }

      console.log("🟡 Admin login attempt:", emailNorm);

      const snap = await db
        .collection("admins")
        .where("email", "==", emailNorm)
        .limit(1)
        .get();

      if (snap.empty) {
        return res.status(400).json({ error: "Admin not found" });
      }

      const adminDoc = snap.docs[0];
      const adminData = adminDoc.data();

      // admin.password MUST be bcrypt hash
      const match = await bcrypt.compare(password, adminData.password);
      if (!match)
        return res.status(403).json({ error: "Invalid credentials" });

      const token = jwt.sign(
        { id: adminDoc.id, email: adminData.email, role: "admin" },
        getJwtSecret(), // ✅ hardened secret, no fallback
        { expiresIn: "7d" }
      );

      return res.json({
        token,
        user: { email: adminData.email, role: "admin" },
      });
    } catch (err) {
      console.error("Admin login error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // =========================================================
  // =============== DRIVER LOGIN ============================
  // =========================================================
  router.post("/driver/login", loginRateLimiter, async (req, res) => {
    const { email, password, passwordHash } = req.body;

    try {
      if (passwordHash) {
        trackSuspiciousActivity(req, "Attempted to send passwordHash to driver login");
        return res.status(400).json({
          error: "Do not send passwordHash. Send plaintext password over HTTPS.",
        });
      }

      const emailNorm = normEmail(email);
      if (!emailNorm || !password) {
        return res
          .status(400)
          .json({ error: "Email and password are required" });
      }

      console.log("🟡 Driver login attempt:", emailNorm);

      const snap = await db
        .collection("drivers")
        .where("email", "==", emailNorm)
        .limit(1)
        .get();

      if (snap.empty) {
        return res.status(400).json({ error: "Driver not found" });
      }

      const driverDoc = snap.docs[0];
      const driverData = driverDoc.data();

      const match = await bcrypt.compare(password, driverData.password);
      if (!match)
        return res.status(403).json({ error: "Invalid credentials" });

      // Issue token
      const token = jwt.sign(
        { id: driverDoc.id, email: driverData.email, role: "driver" },
        getJwtSecret(),
        { expiresIn: "7d" }
      );

      // 🔥 Fetch active assignment WITH route data (stops + polyline)
      const assignSnap = await db
        .collection("assignments")
        .where("driver_id", "==", driverDoc.id)
        .where("active", "==", true)
        .limit(1)
        .get();

      let assignment = null;
      if (!assignSnap.empty) {
        const adoc = assignSnap.docs[0];
        const a = adoc.data();
        const routeId = a.route_id;
        const direction = a.direction || "to";

        assignment = {
          id: adoc.id,
          route_id: routeId,
          route_name: a.route_name,
          direction: direction,
          vehicle_id: a.vehicle_id,
          vehicle_plate: a.vehicle_plate,
          stops: [],
          route_shape: null,
        };

        // Fetch route details for driver's assigned route
        if (routeId) {
          try {
            const routeDoc = await db.collection("routes").doc(routeId).get();
            if (routeDoc.exists) {
              const routeData = routeDoc.data() || {};

              // Get stops for assigned direction
              const rawStops = routeData.directions?.[direction] || [];
              assignment.stops = rawStops
                .map((s, idx) => ({
                  stop_id: s.stop_id || s.id || `stop_${idx}`,
                  name: s.name || s.stop_name || `Stop ${idx + 1}`,
                  sequence: Number.isFinite(s.sequence) ? s.sequence : idx,
                  lat: s.location?.latitude ?? s.lat,
                  lng: s.location?.longitude ?? s.lng ?? s.lon,
                }))
                .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
                .sort((a, b) => a.sequence - b.sequence);

              // Get route shape from cache
              const cachedShape = routeData.shape_cache?.[direction];
              if (cachedShape?.points?.length > 1) {
                assignment.route_shape = {
                  points: cachedShape.points,
                  from_cache: true,
                };
              }

              // Include route color
              if (routeData.color) {
                assignment.route_color = routeData.color;
              }
            }
          } catch (routeErr) {
            console.warn("⚠️ Could not fetch route details on login:", routeErr?.message);
          }
        }
      }

      // Send response
      return res.json({
        token,
        user: {
          id: driverDoc.id,
          email: driverData.email,
          role: "driver",
          name: driverData.name,
          assignment, // ⭐ Now includes stops & route_shape for map display
        },
      });
    } catch (err) {
      console.error("Driver login error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });
  return router;
}