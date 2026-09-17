-- Defence in depth for the brand logo fields.
--
-- The zod schema now rejects anything that is not http or https, but the
-- schema only guards the admin API. A row written by a migration, a seed
-- script, a psql session, or a future endpoint that forgets the check would
-- still reach the widget and be rendered into markup. The constraint makes
-- the database itself refuse the bad value, so there is no path in.
--
-- Any existing bad value is cleared first, otherwise adding the constraint
-- would fail on a deployment that already stored one.

UPDATE brand_config
   SET logo_url = NULL
 WHERE logo_url IS NOT NULL AND logo_url !~* '^https?://';

UPDATE brand_config
   SET logo_dark_url = NULL
 WHERE logo_dark_url IS NOT NULL AND logo_dark_url !~* '^https?://';

ALTER TABLE brand_config
  DROP CONSTRAINT IF EXISTS brand_config_logo_url_scheme;
ALTER TABLE brand_config
  ADD CONSTRAINT brand_config_logo_url_scheme
  CHECK (logo_url IS NULL OR logo_url ~* '^https?://');

ALTER TABLE brand_config
  DROP CONSTRAINT IF EXISTS brand_config_logo_dark_url_scheme;
ALTER TABLE brand_config
  ADD CONSTRAINT brand_config_logo_dark_url_scheme
  CHECK (logo_dark_url IS NULL OR logo_dark_url ~* '^https?://');

-- Same reasoning for offers: a PERCENT offer above 100 is a typo, and an end
-- date at or before the start date creates an offer that never activates.
--
-- Existing bad rows are repaired first, and deactivated rather than silently
-- corrected. Clamping "9000% off" to "100% off" without switching it off
-- would turn a typo into a free order, so a human confirms what it should be.
UPDATE offers
   SET value = 100, active = false
 WHERE kind = 'PERCENT' AND value > 100;

UPDATE offers
   SET ends_at = NULL, active = false
 WHERE starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at <= starts_at;

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_percent_range;
ALTER TABLE offers
  ADD CONSTRAINT offers_percent_range
  CHECK (kind <> 'PERCENT' OR value <= 100);

ALTER TABLE offers
  DROP CONSTRAINT IF EXISTS offers_date_order;
ALTER TABLE offers
  ADD CONSTRAINT offers_date_order
  CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at > starts_at);
