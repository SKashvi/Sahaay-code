-- Replace placeholder demo catalog artwork with real product/editorial photography.
-- This is a new migration because existing installations may already have applied 008.
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1651761179569-4ba2aa054997?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'classic-cotton-tee';
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'relaxed-fit-hoodie';
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1714143164072-7646ef5cb24d?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'wide-leg-jeans';
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1785348056988-c4d7c2248248?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'wrap-midi-dress';
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1744838337050-608797e60e59?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'utility-bomber-jacket';
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1785950717227-08af71c743f4?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'everyday-joggers';
