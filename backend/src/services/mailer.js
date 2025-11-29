// backend/src/services/mailer.js
// Simple placeholder: replace with nodemailer/sendgrid code in production.
async function sendOTPEmail(toEmail, otp) {
  console.log(`[mailer] Sending OTP ${otp} to ${toEmail}`);
  // TODO: integrate with nodemailer or other provider
  return true;
}

module.exports = { sendOTPEmail };
