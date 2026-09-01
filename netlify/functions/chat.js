const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body)
});

async function authenticatedRequest(url, publishableKey, bearer, path, options = {}) {
  return fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: publishableKey,
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    return json(200, {
      live: Boolean(process.env.OPENAI_API_KEY && process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY),
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra'
    });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const messages = Array.isArray(payload.messages) ? payload.messages.slice(-12) : [];
  if (!messages.length) return json(400, { error: 'No messages supplied' });

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return json(503, {
      error: 'Ortiz AI live model is not configured on the server. Add OPENAI_API_KEY to the server environment.'
    });
  }

  const supaUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const bearer = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');

  if (!supaUrl || !publishableKey) {
    return json(503, { error: 'Ortiz AI account service is not configured on the server.' });
  }
  if (!bearer) {
    return json(401, { error: 'Please sign in to use Ortiz AI.' });
  }

  const userRes = await fetch(`${supaUrl}/auth/v1/user`, {
    headers: { apikey: publishableKey, Authorization: `Bearer ${bearer}` }
  });
  if (!userRes.ok) return json(401, { error: 'Your session has expired. Please sign in again.' });
  const user = await userRes.json();

  const profileRes = await authenticatedRequest(
    supaUrl,
    publishableKey,
    bearer,
    `profiles?id=eq.${encodeURIComponent(user.id)}&select=plan,is_active&limit=1`
  );
  const profiles = profileRes.ok ? await profileRes.json() : [];
  const profile = profiles[0] || { plan: 'free', is_active: true };
  if (!profile.is_active) return json(403, { error: 'This Ortiz AI account is disabled.' });

  const planRules = {
    free: { limit: 25, period: 'day' },
    plus: { limit: 1000, period: 'month' },
    pro: { limit: null, period: 'month' },
    admin: { limit: null, period: 'month' }
  };
  const plan = profile.plan || 'free';
  const rule = planRules[plan] || planRules.free;
  const limit = rule.limit;
  const start = new Date();
  if (rule.period === 'month') start.setUTCDate(1);
  start.setUTCHours(0, 0, 0, 0);

  const countRes = await authenticatedRequest(
    supaUrl,
    publishableKey,
    bearer,
    `usage_events?user_id=eq.${encodeURIComponent(user.id)}&created_at=gte.${encodeURIComponent(start.toISOString())}&select=id`,
    { method: 'HEAD', headers: { Prefer: 'count=exact' } }
  );
  const range = countRes.headers.get('content-range') || '0/0';
  const used = Number(range.split('/')[1]) || 0;
  if (limit !== null && used >= limit) {
    return json(429, { error: `${rule.period === 'month' ? 'Monthly' : 'Daily'} ${plan} plan limit reached (${limit} requests).` });
  }
  let usageInfo = { used, limit, period: rule.period };

  const input = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: [{
      type: m.role === 'assistant' ? 'output_text' : 'input_text',
      text: String(m.content || '').slice(0, 120000)
    }]
  }));

  try {
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
        instructions: 'You are Ortiz AI, a helpful, clear, capable personal AI assistant. Keep answers useful, safe, conversational, and concise unless detail is requested.',
        input
      })
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('AI provider error', data);
      return json(502, { error: data?.error?.message || 'AI provider error' });
    }

    const reply = data.output_text || data.output?.flatMap((x) => x.content || []).find((x) => x.type === 'output_text')?.text || 'I could not generate a text response.';

    const insertRes = await fetch(`${supaUrl}/rest/v1/rpc/record_usage_event`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
        p_input_chars: messages.reduce((n, m) => n + String(m.content || '').length, 0),
        p_output_chars: reply.length
      })
    });
    if (!insertRes.ok) console.error('Usage insert failed', await insertRes.text());
    usageInfo = { used: (usageInfo?.used || 0) + 1, limit: usageInfo?.limit ?? null, period: usageInfo?.period || 'day' };

    return json(200, { mode: 'live', reply, usage: usageInfo });
  } catch (error) {
    console.error(error);
    return json(500, { error: 'Server error' });
  }
};