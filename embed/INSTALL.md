# Velour standalone embed

This build is the customer-facing website widget only. It does not expose the Velour storefront, cart, checkout, track-order, or return pages to the visitor.

## Install

Replace `https://YOUR-VELOUR-API.example.com` with the URL of the client's Velour deployment:

```html
<script src="https://YOUR-VELOUR-API.example.com/embed/velour-chat.js" data-api="https://YOUR-VELOUR-API.example.com"></script>
```

The backend must set `CORS_ORIGIN` to the exact origin of the client's website, for example `https://www.client.com`.

The admin dashboard remains available at:

`https://YOUR-VELOUR-API.example.com/admin.html`

## Client setup

1. Run migrations and seed on the client's Postgres database.
2. Configure `AI_PROVIDER` and `AI_API_KEY` (Gemini or Groq are supported in this build).
3. Log into `/admin.html`.
4. Add the client's products, sizes, colors, prices, and product photos.
5. Add the client's policies/FAQs in Knowledge base.
6. Open Widget and set the welcome message and suggested questions.
7. Put the script above into the client's website.

Instagram is intentionally not part of this build.

## Client Content Security Policy

If the client website has a restrictive CSP, allow the Velour deployment origin in `script-src`, `connect-src`, and `style-src`. The widget uses one script, one stylesheet, and API requests to that deployment.

## Hosting on Render
Deploy `backend/` as a Render Web Service with build command `npm install`, start command `npm start`, and health check `/healthz`. Add the `.env` values in Render's Environment settings; do not commit secrets. Render provides a public HTTPS `onrender.com` URL that can be used as the Razorpay webhook target.
