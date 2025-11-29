// backend/src/middleware/auth.js
import jwt from "jsonwebtoken";
import admin from "firebase-admin"; // kept for compatibility / future role checks

// Centralized secret getter: NO weak fallback.
// In dev, index.js ensureJwtSecret() sets process.env.JWT_SECRET early.
// In prod, missing secret is a hard misconfig.
function getJwtSecretOrFail(res) {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    console.error("❌ JWT_SECRET is not set. Refusing to verify tokens.");
    // keep same behavior style as your previous code
    res.status(500).json({ error: "Server misconfigured" });
    return null;
  }
  return secret;
}

export function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (!authHeader)
      return res.status(401).json({ error: "No Authorization header" });

    const [bearer, token] = authHeader.split(" ");
    if (bearer?.toLowerCase() !== "bearer" || !token) {
      return res.status(401).json({ error: "Malformed Authorization header" });
    }

    const secret = getJwtSecretOrFail(res);
    if (!secret) return; // response already sent

    const decoded = jwt.verify(token, secret);

    // preserve your flexible role extraction
    const role =
      decoded.role ||
      decoded.userRole ||
      decoded.type ||
      decoded.roleName ||
      decoded.category ||
      "user";

    const roleNorm = role.toString().toLowerCase().trim();

    // preserve req.user shape + add req.userRole for any newer code
    req.user = {
      id: decoded.id || decoded.uid || decoded.sub || null,
      email: decoded.email || decoded.emailAddress || null,
      role: roleNorm,
      raw: decoded,
    };
    req.userRole = roleNorm;

    next();
  } catch (err) {
    console.error("❌ Auth verification failed:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export async function requireAdmin(req, res, next) {
  try {
    const roleNorm =
      (req.user?.role || req.userRole || "user").toString().toLowerCase().trim();

    if (roleNorm !== "admin") {
      return res.status(403).json({ error: "Admins only" });
    }

    next();
  } catch (err) {
    console.error("requireAdmin error:", err);
    res.status(500).json({ error: "Admin auth failed" });
  }
}