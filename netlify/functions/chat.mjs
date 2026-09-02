const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
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

function env(name) {
  return Netlify.env.get(name) || '';
}

export default async (req) => {
  const geminiKey = env('GEMINI_API_KEY');
  const geminiModel = env('GEMINI_MODEL') || 'gemini-2.5-flash-lite';
  const supaUrl = env('SUPABASE_URL').replace(/\/$/, '');
  const publishableKey = env('SUPABASE_PUBLISHABLE_KEY');

  if (req.method === 'GET') {
    return json(200, {
      live: Boolean(geminiKey && supaUrl && publishableKey),
      provider: 'gemini',
      model: geminiModel
    });
  }
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  let payload;
  try { payload = await req.json(); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const messages = Array.isArray(payload.messages) ? payload.messages.slice(-12) : [];
  if (!messages.length) return json(400, { error: 'No messages supplied' });

  if (!geminiKey) {
    return json(503, {
      error: 'Ortiz AI live model is not configured on the server. Add GEMINI_API_KEY to the server environment.'
    });
  }

  if (!supaUrl || !publishableKey) {
    return json(503, { error: 'Ortiz AI account service is not configured on the server.' });
  }

  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return json(401, { error: 'Please sign in to use Ortiz AI.' });

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

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: String(m.content || '').slice(0, 120000) }]
  })).filter((m) => m.parts[0].text.trim().length > 0);

  if (!contents.length || contents[contents.length - 1].role !== 'user') {
    return json(400, { error: 'A user message is required.' });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': geminiKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: 'You are Ortiz AI, a helpful, clear, capable personal AI assistant. Keep answers useful, safe, conversational, and concise unless detail is requested.'
            }]
          },
          contents
        })
      }
    );

    const data = await response.json();
    if (!response.ok) {
      console.error('Gemini provider error', data);
      return json(502, { error: data?.error?.message || 'Gemini AI provider error' });
    }

    const reply = (data?.candidates?.[0]?.content?.parts || [])
      .map((part) => part?.text || '')
      .join('')
      .trim();

    if (!reply) return json(502, { error: 'Gemini returned no text response.' });

    const insertRes = await fetch(`${supaUrl}/rest/v1/rpc/record_usage_event`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_model: geminiModel,
        p_input_chars: messages.reduce((n, m) => n + String(m.content || '').length, 0),
        p_output_chars: reply.length
      })
    });
    if (!insertRes.ok) console.error('Usage insert failed', await insertRes.text());

    return json(200, {
      mode: 'live',
      provider: 'gemini',
      reply,
      usage: { used: used + 1, limit, period: rule.period }
    });
  } catch (error) {
    console.error(error);
    return json(500, { error: 'Server error' });
  }
};
