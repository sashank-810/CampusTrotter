// backend/src/middleware/rateLimiter.js
// Rate limiting middleware to protect against brute-force attacks

/**
 * In-memory rate limiter store
 * For production, consider using Redis for distributed rate limiting
 */
const rateLimitStore = new Map();

// Cleanup old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of rateLimitStore.entries()) {
    if (now > data.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Create a rate limiter middleware
 * @param {Object} options - Rate limiter options
 * @param {number} options.windowMs - Time window in milliseconds (default: 15 minutes)
 * @param {number} options.max - Maximum requests per window (default: 100)
 * @param {string} options.message - Error message when rate limited
 * @param {string} options.keyPrefix - Prefix for rate limit key (for different endpoints)
 * @param {boolean} options.skipSuccessfulRequests - Don't count successful requests
 * @returns {Function} Express middleware
 */
export function createRateLimiter(options = {}) {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    max = 100,
    message = "Too many requests, please try again later",
    keyPrefix = "rl",
    skipSuccessfulRequests = false,
  } = options;

  return (req, res, next) => {
    // Get client identifier (IP address or user ID if authenticated)
    const clientId =
      req.user?.uid ||
      req.user?.id ||
      req.ip ||
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.connection?.remoteAddress ||
      "unknown";

    const key = `${keyPrefix}:${clientId}`;
    const now = Date.now();

    // Get or create rate limit entry
    let entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetTime) {
      entry = {
        count: 0,
        resetTime: now + windowMs,
      };
      rateLimitStore.set(key, entry);
    }

    // Check if rate limited
    if (entry.count >= max) {
      const retryAfter = Math.ceil((entry.resetTime - now) / 1000);

      res.set("Retry-After", String(retryAfter));
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", "0");
      res.set("X-RateLimit-Reset", String(Math.ceil(entry.resetTime / 1000)));

      return res.status(429).json({
        error: "rate_limit_exceeded",
        message,
        retryAfter,
      });
    }

    // Increment count
    entry.count++;

    // Set rate limit headers
    res.set("X-RateLimit-Limit", String(max));
    res.set("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    res.set("X-RateLimit-Reset", String(Math.ceil(entry.resetTime / 1000)));

    // If skipSuccessfulRequests, decrement on success
    if (skipSuccessfulRequests) {
      const originalEnd = res.end.bind(res);
      res.end = function (...args) {
        if (res.statusCode < 400) {
          entry.count = Math.max(0, entry.count - 1);
        }
        return originalEnd(...args);
      };
    }

    next();
  };
}

/**
 * Pre-configured rate limiters for different use cases
 */

// Strict rate limiter for login attempts (5 attempts per 15 minutes)
export const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  message: "Too many login attempts. Please try again in 15 minutes.",
  keyPrefix: "login",
});

// Strict rate limiter for signup (10 attempts per hour)
export const signupRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "Too many signup attempts. Please try again later.",
  keyPrefix: "signup",
});

// OTP rate limiter (5 OTP requests per 10 minutes)
export const otpRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 5,
  message: "Too many OTP requests. Please wait before requesting again.",
  keyPrefix: "otp",
});

// Password reset rate limiter (3 attempts per hour)
export const passwordResetRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: "Too many password reset attempts. Please try again later.",
  keyPrefix: "pwreset",
});

// General API rate limiter (100 requests per minute)
export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: "Too many requests. Please slow down.",
  keyPrefix: "api",
});

// Feedback submission rate limiter (10 per hour)
export const feedbackRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: "Too many feedback submissions. Please try again later.",
  keyPrefix: "feedback",
});

// Reservation rate limiter (20 per hour)
export const reservationRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: "Too many reservation attempts. Please try again later.",
  keyPrefix: "reservation",
});

// Telemetry rate limiter for drivers (high frequency allowed: 1000 per minute)
export const telemetryRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 1000,
  message: "Telemetry rate limit exceeded.",
  keyPrefix: "telemetry",
});

/**
 * IP-based blocking for suspicious activity
 */
const blockedIPs = new Set();
const suspiciousActivity = new Map();

export function trackSuspiciousActivity(req, reason) {
  const ip =
    req.ip ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection?.remoteAddress;

  if (!ip) return;

  const now = Date.now();
  let entry = suspiciousActivity.get(ip);

  if (!entry || now > entry.resetTime) {
    entry = { count: 0, reasons: [], resetTime: now + 60 * 60 * 1000 }; // 1 hour
    suspiciousActivity.set(ip, entry);
  }

  entry.count++;
  entry.reasons.push({ reason, timestamp: new Date().toISOString() });

  // Block IP after 10 suspicious activities
  if (entry.count >= 10) {
    blockedIPs.add(ip);
    console.warn(`[Security] IP ${ip} blocked due to suspicious activity:`, entry.reasons);

    // Auto-unblock after 24 hours
    setTimeout(() => {
      blockedIPs.delete(ip);
      suspiciousActivity.delete(ip);
    }, 24 * 60 * 60 * 1000);
  }
}

export function isIPBlocked(req) {
  const ip =
    req.ip ||
    req.headers["x-forwarded-for"]?.split(",")[0] ||
    req.connection?.remoteAddress;

  return blockedIPs.has(ip);
}

export function blockCheckMiddleware(req, res, next) {
  if (isIPBlocked(req)) {
    return res.status(403).json({
      error: "access_denied",
      message: "Your IP has been temporarily blocked due to suspicious activity.",
    });
  }
  next();
}
