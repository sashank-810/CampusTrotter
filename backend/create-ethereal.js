import nodemailer from "nodemailer";

nodemailer.createTestAccount((err, account) => {
  if (err) {
    console.error("❌ Failed to create Ethereal account", err);
    return;
  }

  console.log("✅ Ethereal test account created:");
  console.log("User:", account.user);
  console.log("Pass:", account.pass);
  console.log("SMTP Host:", account.smtp.host);
  console.log("SMTP Port:", account.smtp.port);
});
