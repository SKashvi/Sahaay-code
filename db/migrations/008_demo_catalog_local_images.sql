-- Demo catalog photography: use real product/editorial photos so cards look like an actual apparel catalog.
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1651761179569-4ba2aa054997?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'classic-cotton-tee';
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'relaxed-fit-hoodie';
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1714143164072-7646ef5cb24d?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'wide-leg-jeans';
UPDATE products SET image_url = 'https://leann.online/cdn/shop/files/French_Printed_Floral_Midi_Dress_black.jpg?v=1768539482&width=1600', updated_at = now() WHERE slug = 'wrap-midi-dress';
UPDATE products SET image_url = 'https://images.unsplash.com/photo-1744838337050-608797e60e59?auto=format&fit=crop&fm=jpg&q=85&w=1200', updated_at = now() WHERE slug = 'utility-bomber-jacket';
UPDATE products SET image_url = 'https://ness-paris.fr/images/carousel/img_adult_homme_carousel/homme_bas_de_jogging_gris_ness_paris.png', updated_at = now() WHERE slug = 'everyday-joggers';
