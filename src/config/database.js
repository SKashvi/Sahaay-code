function getDatabaseSslConfig(envLike = process.env) {
  if (String(envLike.DATABASE_SSL).toLowerCase() !== 'true') return false;
  return { rejectUnauthorized: String(envLike.DATABASE_SSL_INSECURE).toLowerCase() !== 'true' };
}

module.exports = { getDatabaseSslConfig };
