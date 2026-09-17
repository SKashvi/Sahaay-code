-- Customer-facing widget copy/settings editable from Admin.
CREATE TABLE IF NOT EXISTS widget_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  welcome_message TEXT NOT NULL DEFAULT 'Hi! How can I help you today?',
  suggested_questions TEXT[] NOT NULL DEFAULT ARRAY[
    'What would you recommend for me?',
    'What is your return policy?',
    'When will my order arrive?',
    'What are your shipping charges?'
  ],
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO widget_settings (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;
