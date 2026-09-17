const { env } = require('./config/env');
const app = require('./app');
const { releaseExpiredReservations } = require('./lib/inventoryReservations');

const server = app.listen(env.PORT, async () => {
  console.log(`Velour backend listening on port ${env.PORT} (${env.NODE_ENV})`);
  try {
    await releaseExpiredReservations();
  } catch (err) {
    console.error('Initial reservation cleanup failed:', err.message);
  }
});

const reservationCleanup = setInterval(() => {
  releaseExpiredReservations().catch((err) => console.error('Reservation cleanup failed:', err.message));
}, 5 * 60 * 1000);
reservationCleanup.unref();

async function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  clearInterval(reservationCleanup);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
