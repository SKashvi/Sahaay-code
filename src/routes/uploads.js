const express = require('express');
const multer = require('multer');
const { uploadImage, ALLOWED_MIME, MAX_BYTES, detectImageMime } = require('../lib/storage');
const { uploadLimiter } = require('../middleware/rateLimiters');
const { requireAdmin } = require('../middleware/adminAuth');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(Object.assign(new Error('Only JPEG, PNG, or WEBP images are allowed'), { status: 400 }));
    }
    cb(null, true);
  },
});

function uploadValidated(fieldName, folder, requireAdminUser = false) {
  const middleware = requireAdminUser ? [requireAdmin, uploadLimiter] : [uploadLimiter];
  return [...middleware, (req, res, next) => {
    upload.single(fieldName)(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
      if (!req.file) return res.status(400).json({ error: 'No file received' });
      try {
        if (detectImageMime(req.file.buffer) !== req.file.mimetype) {
          return res.status(400).json({ error: 'Uploaded file contents do not match the declared image type' });
        }
        const url = await uploadImage({
          buffer: req.file.buffer,
          mimeType: req.file.mimetype,
          originalName: req.file.originalname,
          folder,
        });
        res.status(201).json({ url, uploadedAt: new Date().toISOString() });
      } catch (uploadErr) {
        next(uploadErr);
      }
    });
  }];
}

router.post('/return-photo', ...uploadValidated('photo', 'returns'));
router.post('/brand', ...uploadValidated('image', 'brand', true));
router.post('/product-image', ...uploadValidated('image', 'products', true));

module.exports = router;
