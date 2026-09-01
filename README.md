# Ortiz AI v2

Ortiz AI v2 is a deployment-ready AI chat web app with guest mode, Supabase email/password authentication, cloud conversation history, per-user Row Level Security, server-side AI usage limits, a protected admin overview, text-file attachments, and responsive dark UI.

## Quick start

1. Create a dedicated Supabase project for Ortiz AI.
2. Run `supabase/migrations/001_ortiz_ai_schema.sql` in that project's SQL editor.
3. In `config.js`, set only the project's **Supabase URL** and **publishable key**. Never put the service-role key in browser code.
4. In Netlify environment variables set `OPENAI_API_KEY`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. Optionally set `OPENAI_MODEL`.
5. Run `npm run dev` for local testing (the script uses a pinned Netlify CLI), or deploy the folder to Netlify.

## Make an admin

Admin authorization uses Supabase Auth `app_metadata.role`, not editable user metadata. Set `role: "admin"` in the target user's app metadata using a trusted server/admin tool, and set the matching `public.profiles.role` and `plan` to `admin`. The browser never receives the service-role key.

## Plans

The included Netlify function enforces daily request limits: Free = 25/day, Ortiz Plus = 1,000/month, Ortiz Pro = unlimited, Admin = unlimited. Change the `limits` object in `netlify/functions/chat.js` if you want different quotas.

## Important security notes

- All public tables have RLS enabled.
- Users can only read/write their own conversations and messages.
- Authenticated users can update only safe profile columns; role/plan changes are server/admin responsibilities.
- `SUPABASE_SERVICE_ROLE_KEY` belongs only in Netlify environment variables.
- The AI API key also stays server-side.


## Plans
- Free: $0, 25 AI messages per day
- Ortiz Plus: $5/month, 1,000 AI messages per month
- Ortiz Pro: $15/month, unlimited AI messages

The pricing UI is present, but payment processing is intentionally not enabled yet.


## Local testing before deployment

Do not use a plain static/Live Server when testing Live AI. A static server cannot execute the backend route at `/.netlify/functions/chat`.

1. Copy `.env.local.example` to `.env.local`.
2. Put your OpenAI API key only in `.env.local`.
3. Run `npm run dev`.
4. Open `http://localhost:8888`.

This local Node server serves both the frontend and the same chat backend route that the deployed Netlify site will use later.


## If you only unzip and open index.html

That opens the app in **direct file preview** mode. You can inspect the layout, menus, theme, plans, microphone controls, and other frontend behavior.

Live AI cannot run from `file://` because there is no backend process. The app now detects this and shows **Preview only** instead of a misleading connection error.


## Account and pricing updates in v2.10

- Email signup now detects Supabase's duplicate/obfuscated signup response where possible and tells the user: **"This account already exists. Please sign in instead."**
- The auth modal now includes **Continue with Google** using Supabase OAuth.
- Google OAuth needs the Google provider enabled in Supabase and a valid web redirect URL. It cannot complete when `index.html` is opened directly with `file://`.
- Plus and Pro pricing buttons are now wired to secure checkout URLs through `config.js -> billingUrls`. Only public payment/checkout links belong there. Never put payment provider secret keys in frontend files.
- Clicking a paid plan never changes a user's database plan by itself. The paid plan should only be granted after verified payment confirmation from the billing provider/backend.


## v2.11 live Stripe checkout
Ortiz Plus and Ortiz Pro now point to live Stripe monthly subscription checkout links. Plan access must still be granted only after verified payment confirmation; checkout alone must not directly change the Supabase profile plan.

## v2.12 — verified Stripe billing + closable mobile menu

### Mobile menu
The mobile sidebar now has an **×** button in its top-right corner. It can also be closed by tapping outside the sidebar or pressing Escape.

### Secure subscription activation
Stripe checkout never changes a plan from frontend JavaScript. A new server-only webhook at:

`/.netlify/functions/stripe-webhook`

verifies Stripe's webhook signature before updating a profile. It handles successful checkout, subscription updates/cancellations, failed invoices, and records processed Stripe event IDs to avoid duplicate handling.

The Supabase project has already received migration `stripe_billing_tracking`, which adds the Stripe subscription tracking columns and a protected billing event table. Authenticated users cannot update their own plan or Stripe billing fields.

### Secrets required when the backend is eventually hosted
Set these only in the server environment. Never place them in `config.js` or frontend files:

- `STRIPE_WEBHOOK_SECRET` — Stripe webhook signing secret for the deployed webhook endpoint.
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase server-only service role key used by the verified webhook to update billing state.

The existing live Stripe Payment Links remain public frontend configuration and are safe to expose.

Because this project is intentionally not deployed yet, Stripe cannot send production webhook events to the ZIP while it is opened directly from `file://`. The verification code and database protections are prepared now; the final webhook endpoint/secret is connected when there is an HTTPS deployment URL.
