// backend/src/services/otpService.js
const crypto = require('crypto');

function generateOTP() {
  // 6-digit numeric OTP
  const otp = crypto.randomInt(100000, 999999).toString();
  return otp;
}

function isOTPExpired(expiryDate) {
  if (!expiryDate) return true;
  return new Date() > expiryDate;
}

module.exports = {
  generateOTP,
  isOTPExpired
};
