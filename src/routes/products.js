const express = require('express');
const db = require('../lib/db');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, slug, name, price, fabric, icon_key AS "iconKey", image_url AS "imageUrl", sizes, colors
       FROM products WHERE active = true ORDER BY created_at ASC`
    );
    res.json({ products: result.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
