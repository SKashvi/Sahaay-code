const { sendEmail } = require('./email');
const { paiseToRupeeString } = require('./ids');
const { env } = require('../config/env');

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function wrap(bodyHtml) {
  return `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
    <h2 style="font-family:serif;">${env.BRAND_NAME}</h2>
    ${bodyHtml}
    <p style="color:#888;font-size:12px;margin-top:24px;">${env.BRAND_TAGLINE}</p>
  </div>`;
}

async function notifyOrderConfirmed(order) {
  const itemLines = order.items.map((i) => `${i.name} (${i.size}, ${i.color}) x ${i.qty}`).join('<br>');
  await sendEmail({
    to: order.customerEmail,
    subject: `Order ${order.displayId} confirmed`,
    html: wrap(`<p>Thanks for your order, ${escapeHtml(order.customerName)}.</p><p><strong>${order.displayId}</strong></p><p>${itemLines}</p><p>Total: ${paiseToRupeeString(order.total)}</p>`),
    text: `Order ${order.displayId} confirmed. Total: ${paiseToRupeeString(order.total)}`,
  });
}

async function notifyOrderShipped(order) {
  const trackingLine = order.trackingNumber
    ? `Tracking: ${escapeHtml(order.trackingCarrier || '')} ${escapeHtml(order.trackingNumber)}${order.trackingUrl ? ` (${escapeHtml(order.trackingUrl)})` : ''}`
    : '';
  await sendEmail({
    to: order.customerEmail,
    subject: `Order ${order.displayId} has shipped`,
    html: wrap(`<p>Your order <strong>${order.displayId}</strong> is on its way.</p><p>${trackingLine}</p>`),
    text: `Order ${order.displayId} has shipped. ${trackingLine}`,
  });
}

async function notifyOrderDelivered(order) {
  await sendEmail({
    to: order.customerEmail,
    subject: `Order ${order.displayId} delivered`,
    html: wrap(`<p>Your order <strong>${order.displayId}</strong> has been delivered. Hope you love it.</p>`),
    text: `Order ${order.displayId} delivered.`,
  });
}

async function notifyReturnSubmitted(email, returnDisplayId, orderDisplayId) {
  await sendEmail({
    to: email,
    subject: `Return request ${returnDisplayId} received`,
    html: wrap(`<p>We received your return request <strong>${returnDisplayId}</strong> for order ${orderDisplayId}. We will email you once it has been reviewed.</p>`),
    text: `Return request ${returnDisplayId} for order ${orderDisplayId} received.`,
  });
}

async function notifyReturnDecision(email, returnDisplayId, approved) {
  await sendEmail({
    to: email,
    subject: `Return ${returnDisplayId} ${approved ? 'approved' : 'update'}`,
    html: wrap(approved
      ? `<p>Your return <strong>${returnDisplayId}</strong> has been approved. A refund will follow shortly.</p>`
      : `<p>Your return <strong>${returnDisplayId}</strong> was not approved. Contact support if you have questions.</p>`),
    text: approved ? `Return ${returnDisplayId} approved.` : `Return ${returnDisplayId} was not approved.`,
  });
}

async function notifyRefundCompleted(email, returnDisplayId, refundAmount) {
  await sendEmail({
    to: email,
    subject: `Refund completed for return ${returnDisplayId}`,
    html: wrap(`<p>Your refund of <strong>${paiseToRupeeString(refundAmount)}</strong> for return ${returnDisplayId} has been processed. It may take a few days to appear on your statement.</p>`),
    text: `Refund of ${paiseToRupeeString(refundAmount)} completed for return ${returnDisplayId}.`,
  });
}

module.exports = {
  notifyOrderConfirmed,
  notifyOrderShipped,
  notifyOrderDelivered,
  notifyReturnSubmitted,
  notifyReturnDecision,
  notifyRefundCompleted,
};
