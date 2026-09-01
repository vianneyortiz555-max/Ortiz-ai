const crypto = require('crypto');

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

function getRawBody(event) {
  const body = event.body || '';
  return event.isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
}

function verifyStripeSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(',').map((part) => part.trim());
  const timestamp = parts.find((p) => p.startsWith('t='))?.slice(2);
  const signatures = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!timestamp || !signatures.length) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const expectedBuffer = Buffer.from(expected, 'hex');
  return signatures.some((sig) => {
    try {
      const actual = Buffer.from(sig, 'hex');
      return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
    } catch {
      return false;
    }
  });
}

function serviceHeaders(serviceKey, extra = {}) {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function alreadyProcessed(supaUrl, serviceKey, eventId) {
  const res = await fetch(
    `${supaUrl}/rest/v1/billing_events?stripe_event_id=eq.${encodeURIComponent(eventId)}&select=stripe_event_id&limit=1`,
    { headers: serviceHeaders(serviceKey) }
  );
  if (!res.ok) throw new Error(`Could not check billing event: ${await res.text()}`);
  const rows = await res.json();
  return rows.length > 0;
}

async function markProcessed(supaUrl, serviceKey, event) {
  const res = await fetch(`${supaUrl}/rest/v1/billing_events`, {
    method: 'POST',
    headers: serviceHeaders(serviceKey, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ stripe_event_id: event.id, event_type: event.type })
  });
  if (!res.ok && res.status !== 409) throw new Error(`Could not record billing event: ${await res.text()}`);
}

async function updateProfileByUserId(supaUrl, serviceKey, userId, patch) {
  if (!/^[0-9a-f-]{36}$/i.test(String(userId || ''))) throw new Error('Invalid Ortiz AI user reference');
  const res = await fetch(`${supaUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: serviceHeaders(serviceKey, { Prefer: 'return=minimal' }),
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(`Could not update Ortiz AI profile: ${await res.text()}`);
}

async function findProfileBySubscription(supaUrl, serviceKey, subscriptionId) {
  if (!subscriptionId) return null;
  const res = await fetch(
    `${supaUrl}/rest/v1/profiles?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=id,plan&limit=1`,
    { headers: serviceHeaders(serviceKey) }
  );
  if (!res.ok) throw new Error(`Could not find subscription owner: ${await res.text()}`);
  return (await res.json())[0] || null;
}

function validPaidPlan(plan) {
  return plan === 'plus' || plan === 'pro' ? plan : null;
}

function isoFromUnix(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0
    ? new Date(Number(value) * 1000).toISOString()
    : null;
}

async function processEvent(event, supaUrl, serviceKey) {
  const object = event.data?.object || {};

  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    const userId = object.client_reference_id;
    const plan = validPaidPlan(object.metadata?.plan);
    if (!userId || !plan) return;

    await updateProfileByUserId(supaUrl, serviceKey, userId, {
      plan,
      stripe_customer_id: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
      stripe_subscription_id: typeof object.subscription === 'string' ? object.subscription : object.subscription?.id || null,
      subscription_status: 'active'
    });
    return;
  }

  if (event.type.startsWith('customer.subscription.')) {
    const subscriptionId = object.id;
    const profile = await findProfileBySubscription(supaUrl, serviceKey, subscriptionId);
    if (!profile) return;

    const status = object.status || null;
    const planFromStripe = validPaidPlan(object.metadata?.plan);
    const paidAndUsable = status === 'active' || status === 'trialing';
    const shouldDowngrade = ['canceled', 'unpaid', 'incomplete_expired', 'paused'].includes(status);
    const patch = {
      stripe_customer_id: typeof object.customer === 'string' ? object.customer : object.customer?.id || null,
      stripe_subscription_id: subscriptionId,
      subscription_status: status,
      current_period_end: isoFromUnix(object.current_period_end)
    };

    if (paidAndUsable && planFromStripe) patch.plan = planFromStripe;
    if (event.type === 'customer.subscription.deleted' || shouldDowngrade) patch.plan = 'free';
    await updateProfileByUserId(supaUrl, serviceKey, profile.id, patch);
    return;
  }

  if (event.type === 'invoice.payment_failed') {
    const subscriptionId = typeof object.subscription === 'string' ? object.subscription : object.subscription?.id;
    const profile = await findProfileBySubscription(supaUrl, serviceKey, subscriptionId);
    if (profile) {
      await updateProfileByUserId(supaUrl, serviceKey, profile.id, { subscription_status: 'past_due' });
    }
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const supaUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!supaUrl || !serviceKey || !webhookSecret) {
    return json(503, { error: 'Billing webhook is not configured.' });
  }

  const rawBody = getRawBody(event);
  const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!verifyStripeSignature(rawBody, signature, webhookSecret)) {
    return json(400, { error: 'Invalid Stripe signature.' });
  }

  let stripeEvent;
  try { stripeEvent = JSON.parse(rawBody); }
  catch { return json(400, { error: 'Invalid Stripe payload.' }); }

  try {
    if (await alreadyProcessed(supaUrl, serviceKey, stripeEvent.id)) {
      return json(200, { received: true, duplicate: true });
    }
    await processEvent(stripeEvent, supaUrl, serviceKey);
    await markProcessed(supaUrl, serviceKey, stripeEvent);
    return json(200, { received: true });
  } catch (error) {
    console.error('Stripe billing webhook error', error);
    return json(500, { error: 'Billing event processing failed.' });
  }
};
