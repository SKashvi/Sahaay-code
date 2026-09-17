/* Run with: node db/seed.js
 * Reads ADMIN_EMAIL / ADMIN_PASSWORD from the environment so the very
 * first login credential is never hardcoded into the repository. */
require('dotenv').config();
const { Pool } = require('pg');
const { getDatabaseSslConfig } = require('../src/config/database');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: getDatabaseSslConfig() });

const STARTER_PRODUCTS = [
  { slug: 'classic-cotton-tee', name: 'Classic Cotton Tee', price: 79900, fabric: '100% combed cotton', iconKey: 'tee', imageUrl: '/product-images/classic-cotton-tee.png', sizes: ['S', 'M', 'L', 'XL'], colors: [{ name: 'Black', hex: '#1B1330' }, { name: 'White', hex: '#FFFFFF' }, { name: 'Sage', hex: '#9CAE8C' }] },
  { slug: 'relaxed-fit-hoodie', name: 'Relaxed Fit Hoodie', price: 189900, fabric: 'Cotton fleece blend', iconKey: 'hoodie', imageUrl: '/product-images/relaxed-fit-hoodie.png', sizes: ['S', 'M', 'L', 'XL', 'XXL'], colors: [{ name: 'Charcoal', hex: '#3A3542' }, { name: 'Violet Mist', hex: '#B7ACFF' }, { name: 'Cream', hex: '#F1E9DD' }] },
  { slug: 'wide-leg-jeans', name: 'High Rise Wide Leg Jeans', price: 219900, fabric: 'Stretch denim', iconKey: 'jeans', imageUrl: '/product-images/wide-leg-jeans.png', sizes: ['26', '28', '30', '32', '34'], colors: [{ name: 'Indigo', hex: '#3B4A7A' }, { name: 'Black', hex: '#1B1330' }] },
  { slug: 'wrap-midi-dress', name: 'Wrap Midi Dress', price: 259900, fabric: 'Viscose crepe', iconKey: 'dress', imageUrl: '/product-images/wrap-midi-dress.png', sizes: ['XS', 'S', 'M', 'L'], colors: [{ name: 'Terracotta', hex: '#C1795A' }, { name: 'Ink Blue', hex: '#2A3352' }] },
  { slug: 'utility-bomber-jacket', name: 'Utility Bomber Jacket', price: 349900, fabric: 'Nylon shell', iconKey: 'jacket', imageUrl: '/product-images/utility-bomber-jacket.png', sizes: ['S', 'M', 'L', 'XL'], colors: [{ name: 'Olive', hex: '#6E7A52' }, { name: 'Black', hex: '#1B1330' }] },
  { slug: 'everyday-joggers', name: 'Everyday Joggers', price: 139900, fabric: 'French terry', iconKey: 'joggers', imageUrl: '/product-images/everyday-joggers.png', sizes: ['S', 'M', 'L', 'XL'], colors: [{ name: 'Grey Melange', hex: '#B7B2BE' }, { name: 'Black', hex: '#1B1330' }] },
];

const STARTER_KB = [
  { topic: 'Sizing', content: 'Tees and joggers run true to size. Hoodies and jackets are cut slightly relaxed, size down if you prefer a fitted look.' },
  { topic: 'Shipping', content: 'Orders are processed within 1 to 2 business days and delivered within 4 to 7 business days across India. Shipping is free above Rs 1,999, otherwise a flat Rs 99 applies.' },
  { topic: 'Returns', content: 'Returns and exchanges are accepted within 14 days of delivery provided the item is unworn with tags attached. Start a return from the order tracking page.' },
  { topic: 'Fabric care', content: 'Machine wash cold, inside out, with similar colors. Avoid tumble drying printed pieces.' },
];

async function main() {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD in the environment before seeding.');
    process.exit(1);
  }
  if (adminPassword.length < 10) {
    console.error('ADMIN_PASSWORD should be at least 10 characters.');
    process.exit(1);
  }

  const existingAdmin = await pool.query('SELECT id FROM admin_users WHERE lower(email) = lower($1)', [adminEmail]);
  if (!existingAdmin.rows.length) {
    const hash = await bcrypt.hash(adminPassword, 12);
    await pool.query(
      'INSERT INTO admin_users (id, email, password_hash, name) VALUES ($1,$2,$3,$4)',
      [crypto.randomUUID(), adminEmail, hash, 'Store Admin']
    );
    console.log('Created admin user:', adminEmail);
  } else {
    console.log('Admin user already exists, skipping:', adminEmail);
  }

  for (const p of STARTER_PRODUCTS) {
    const existing = await pool.query('SELECT id FROM products WHERE slug = $1', [p.slug]);
    let productId;
    if (existing.rows.length) {
      productId = existing.rows[0].id;
      await pool.query(
        `UPDATE products SET image_url = COALESCE(image_url, $1), updated_at = now() WHERE id = $2`,
        [p.imageUrl || null, productId]
      );
    } else {
      productId = crypto.randomUUID();
      await pool.query(
        `INSERT INTO products (id, slug, name, price, fabric, icon_key, image_url, sizes, colors)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [productId, p.slug, p.name, p.price, p.fabric, p.iconKey, p.imageUrl || null, p.sizes, JSON.stringify(p.colors)]
      );
    }
    // Every size x color combination gets a starter variant with a modest
    // default stock, so a fresh deployment is immediately sellable rather
    // than silently out of stock on everything until someone visits the
    // admin Inventory screen. Treat this number as a placeholder, not a
    // real count, adjust it to match what you actually have.
    const parsedStock = Number(process.env.DEFAULT_VARIANT_STOCK);
    const defaultStock = Number.isFinite(parsedStock) ? Math.max(0, parsedStock) : 20;
    for (const size of p.sizes) {
      for (const color of p.colors) {
        const sku = `${p.slug.toUpperCase()}-${size.toUpperCase()}-${color.name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
        const existingVariant = await pool.query(
          'SELECT id FROM product_variants WHERE product_id = $1 AND size = $2 AND color = $3',
          [productId, size, color.name]
        );
        if (existingVariant.rows.length) continue;
        await pool.query(
          `INSERT INTO product_variants (id, product_id, sku, size, color, stock_quantity) VALUES ($1,$2,$3,$4,$5,$6)`,
          [crypto.randomUUID(), productId, sku, size, color.name, defaultStock]
        );
      }
    }
  }
  console.log('Starter catalog and variants seeded (existing slugs and variants left untouched).');

  for (const k of STARTER_KB) {
    const existing = await pool.query('SELECT id FROM knowledge_base_entries WHERE topic = $1', [k.topic]);
    if (existing.rows.length) continue;
    await pool.query(
      'INSERT INTO knowledge_base_entries (id, topic, content) VALUES ($1,$2,$3)',
      [crypto.randomUUID(), k.topic, k.content]
    );
  }
  console.log('Starter knowledge base seeded (existing topics left untouched).');

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
