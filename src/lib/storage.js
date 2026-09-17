const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const { env } = require('../config/env');

const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT, // leave unset for real AWS S3, set for R2 / Backblaze / DO Spaces / MinIO
  forcePathStyle: Boolean(env.S3_ENDPOINT), // most S3-compatible providers need this when a custom endpoint is set
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

function assertImageBytesMatchMime(buffer, mimeType) {
  const actualMime = detectImageMime(buffer);
  if (!actualMime || actualMime !== mimeType) {
    throw Object.assign(new Error('Uploaded file contents do not match the declared image type'), { status: 400 });
  }
}

/**
 * Uploads a validated image buffer to object storage and returns a public URL.
 * Validation of mime type and size happens here as a second check, on top of
 * the multer file filter, since the two run at different layers and defense
 * in depth is the point.
 */
async function uploadImage({ buffer, mimeType, originalName, folder }) {
  if (!ALLOWED_MIME.has(mimeType)) {
    throw Object.assign(new Error('Unsupported file type'), { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    throw Object.assign(new Error('File too large'), { status: 400 });
  }
  assertImageBytesMatchMime(buffer, mimeType);
  const ext = (originalName.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
  const key = `${folder}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: env.S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));

  const base = env.S3_PUBLIC_BASE_URL || `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`;
  return `${base.replace(/\/$/, '')}/${key}`;
}

function publicBase() {
  return (env.S3_PUBLIC_BASE_URL || `https://${env.S3_BUCKET}.s3.${env.S3_REGION}.amazonaws.com`).replace(/\/$/, '');
}

/** True only for a URL this server itself generated via uploadImage(). The
 * return-request endpoint accepts a photoUrl from the client, and without
 * this check it would accept literally any URL on the internet, someone
 * could attach an unrelated or malicious link to a return with no proof it
 * ever went through the upload/validation path above. */
function isOwnUploadUrl(url) {
  if (typeof url !== 'string') return false;
  return url.startsWith(publicBase() + '/');
}

module.exports = { uploadImage, isOwnUploadUrl, ALLOWED_MIME, MAX_BYTES, detectImageMime, assertImageBytesMatchMime };
