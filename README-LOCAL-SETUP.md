# Velour Storefront - Local Demo Setup

## Start

1. Configure `.env` for your Render Postgres and API keys.
2. Run `npm install` once.
3. Run `node db/migrate.js`.
4. Run `node db/seed.js`.
5. Start with `npm start`.

For running both builds on one PC, give one build `PORT=4000` and the other `PORT=4001`, and use the same Render Postgres only if you intentionally want both to share the same catalog/admin data. For a clean comparison, use separate databases.

## Demo images

Starter products use local `/product-images/*.png` assets, so they do not depend on Google/Unsplash hotlinks. Replace them later from Admin > Products using Image Upload.
