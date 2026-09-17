/**
 * Provider-agnostic email sending. EMAIL_PROVIDER picks which one:
 *   - "resend": a real transactional email provider (https://resend.com),
 *     one HTTP call, no extra SDK dependency needed.
 *   - "console": logs the email instead of sending it, for local
 *     development or a deployment that has not set up email yet.
 *   - unset: emails are silently skipped (see notifications.js), so a
 *     deployment without email configured still works for everything
 *     else, it just does not send mail.
 * Adding a real SMTP provider later means one new file here with the same
 * shape, nothing that calls sendEmail() needs to change.
 */

async function sendViaResend({ to, subject, html, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM_ADDRESS,
      to,
      subject,
      html,
      text,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API returned ${res.status}: ${body.slice(0, 300)}`);
  }
}

async function sendViaConsole({ to, subject, text }) {
  console.log(`[email:console] to=${to} subject="${subject}"\n${text}`);
}

/**
 * Never throws. A broken email provider must not be able to fail an
 * order, a payment confirmation, or a refund, callers rely on that, they
 * do not wrap this in their own try/catch.
 */
async function sendEmail({ to, subject, html, text }) {
  const provider = process.env.EMAIL_PROVIDER;
  if (!provider) return; // email not configured for this deployment, skip quietly
  try {
    if (provider === 'resend') {
      await sendViaResend({ to, subject, html, text });
    } else if (provider === 'console') {
      await sendViaConsole({ to, subject, text });
    } else {
      console.error(`Unknown EMAIL_PROVIDER "${provider}", email not sent.`);
      return;
    }
  } catch (err) {
    console.error('Email send failed (order/payment/refund processing continues regardless):', err.message);
  }
}

module.exports = { sendEmail };
