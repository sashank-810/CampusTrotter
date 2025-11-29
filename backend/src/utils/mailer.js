import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// Gmail SMTP transporter
export const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS, // App Password
  },
});

// Send OTP email
export const sendOtpEmail = async (to, otp) => {
  const mailOptions = {
    from: `"Transvahan" <${process.env.EMAIL_USER}>`,
    to, // recipient email (user)
    subject: "Your Transvahan OTP Code",
    text: `Your OTP for verifying your Transvahan account is: ${otp}\n\nThis code expires in 5 minutes.`,
  };

  await transporter.sendMail(mailOptions);
};

/**
 * Send high demand alert email to admins
 * Used for short-term planning - admins can quickly dispatch vehicles to surge areas
 *
 * @param {string[]} adminEmails - List of admin email addresses
 * @param {Object} demandData - Demand signal data
 * @param {string} demandData.vehicle_id - Vehicle that reported demand
 * @param {string} demandData.route_id - Route ID
 * @param {string} demandData.route_name - Route name (if available)
 * @param {string} demandData.direction - Direction (to/fro)
 * @param {string} demandData.driver_name - Driver name (if available)
 * @param {number} demandData.lat - Latitude
 * @param {number} demandData.lon - Longitude
 */
export const sendDemandAlertEmail = async (adminEmails, demandData) => {
  if (!adminEmails || adminEmails.length === 0) {
    console.warn("[mailer] No admin emails configured for demand alerts");
    return;
  }

  const {
    vehicle_id,
    route_id,
    route_name,
    direction,
    driver_name,
    lat,
    lon,
  } = demandData;

  const mapsLink = `https://www.google.com/maps?q=${lat},${lon}`;
  const timestamp = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

  const subject = `🚨 High Demand Alert - ${route_name || route_id} (${direction?.toUpperCase() || "TO"})`;

  const text = `
HIGH DEMAND ALERT - ACTION REQUIRED
====================================

A driver has reported high passenger demand at their current location.

DETAILS:
- Route: ${route_name || route_id}
- Direction: ${direction?.toUpperCase() || "TO"}
- Vehicle: ${vehicle_id}
- Driver: ${driver_name || "Unknown"}
- Time: ${timestamp}
- Location: ${lat?.toFixed(6)}, ${lon?.toFixed(6)}

VIEW ON MAP: ${mapsLink}

RECOMMENDED ACTION:
Consider dispatching an additional vehicle to this area to handle the surge demand.

---
This is an automated alert from Transvahan Fleet Management System.
`;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: linear-gradient(135deg, #ef4444, #dc2626); color: white; padding: 20px; border-radius: 8px 8px 0 0; }
    .header h1 { margin: 0; font-size: 20px; }
    .content { background: #f8fafc; padding: 20px; border: 1px solid #e2e8f0; }
    .detail-row { display: flex; padding: 8px 0; border-bottom: 1px solid #e2e8f0; }
    .detail-label { font-weight: 600; width: 120px; color: #64748b; }
    .detail-value { flex: 1; color: #0f172a; }
    .action-box { background: #fef3c7; border: 1px solid #f59e0b; padding: 15px; border-radius: 6px; margin-top: 15px; }
    .action-box h3 { margin: 0 0 8px 0; color: #92400e; font-size: 14px; }
    .action-box p { margin: 0; color: #78350f; font-size: 13px; }
    .map-btn { display: inline-block; background: #2563eb; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; margin-top: 15px; font-weight: 600; }
    .footer { text-align: center; padding: 15px; color: #94a3b8; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🚨 High Demand Alert</h1>
    </div>
    <div class="content">
      <p>A driver has reported <strong>high passenger demand</strong> at their current location.</p>

      <div class="detail-row">
        <span class="detail-label">Route:</span>
        <span class="detail-value"><strong>${route_name || route_id}</strong></span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Direction:</span>
        <span class="detail-value">${direction?.toUpperCase() || "TO"}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Vehicle:</span>
        <span class="detail-value">${vehicle_id}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Driver:</span>
        <span class="detail-value">${driver_name || "Unknown"}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Time:</span>
        <span class="detail-value">${timestamp}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Coordinates:</span>
        <span class="detail-value">${lat?.toFixed(6)}, ${lon?.toFixed(6)}</span>
      </div>

      <a href="${mapsLink}" class="map-btn">📍 View Location on Google Maps</a>

      <div class="action-box">
        <h3>⚡ Recommended Action</h3>
        <p>Consider dispatching an additional vehicle to this area to handle the surge demand and reduce passenger wait times.</p>
      </div>
    </div>
    <div class="footer">
      Transvahan Fleet Management System
    </div>
  </div>
</body>
</html>
`;

  const mailOptions = {
    from: `"Transvahan Alerts" <${process.env.EMAIL_USER}>`,
    to: adminEmails.join(", "),
    subject,
    text,
    html,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[mailer] Demand alert sent to ${adminEmails.length} admin(s)`);
  } catch (err) {
    console.error("[mailer] Failed to send demand alert:", err?.message || err);
    // Don't throw - email failure shouldn't break the demand signal flow
  }
};
