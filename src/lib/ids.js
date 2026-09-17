const crypto = require('crypto');

function newId() {
  return crypto.randomUUID();
}

// Short, human-typeable reference shown to customers, e.g. VEL-4F92A1C8.
// Not the primary key, just a display label, so collisions are checked by the caller.
function newDisplayId(prefix) {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  return prefix + '-' + rand;
}

function rupeesToPaise(rupees) {
  return Math.round(Number(rupees) * 100);
}

function paiseToRupeeString(paise) {
  return '\u20B9' + (Number(paise) / 100).toLocaleString('en-IN');
}

module.exports = { newId, newDisplayId, rupeesToPaise, paiseToRupeeString };
