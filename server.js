const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const crypto = require('crypto');

const app = express();

app.use(cors({
  origin: [
    'https://suslikkkab-eng.github.io',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'null'
  ]
}));

app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const WA_NUMBER = process.env.WA_NUMBER || '';
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';
const APPS_SCRIPT_SECRET = process.env.APPS_SCRIPT_SECRET || '';

const sessions = {};
const rateStore = {};

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function rateLimit(req, res, next) {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  const now = Date.now();

  if (!rateStore[ip]) {
    rateStore[ip] = { count: 0, start: now };
  }

  if (now - rateStore[ip].start > 60000) {
    rateStore[ip] = { count: 0, start: now };
  }

  rateStore[ip].count += 1;

  if (rateStore[ip].count > 60) {
    return res.status(429).json({ ok: false, error: 'Too many requests' });
  }

  next();
}

app.use(rateLimit);

function checkAdminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];

  if (!token || !sessions[token]) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  const session = sessions[token];
  const maxAge = 30 * 60 * 1000;

  if (Date.now() - session.createdAt > maxAge) {
    delete sessions[token];
    return res.status(403).json({ ok: false, error: 'Session expired' });
  }

  next();
}

app.get('/api/config', (req, res) => {
  res.json({
    wa_number: WA_NUMBER,
    apps_script_url: '',
    backend_url: ''
  });
});

async function sendTelegramMessage(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

  await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TG_CHAT_ID,
      text
    })
  });
}

function validatePayload(payload) {
  const type = payload && payload.type;

  if (type === 'quiz') {
    const { name, phone, business, budget, request, hasSales, lang, source, utm } = payload;

    if (!name || String(name).trim().length === 0) return { error: 'name required' };
    if (!phone || String(phone).trim().length === 0) return { error: 'phone required' };

    return {
      value: {
        type,
        name: String(name).trim(),
        phone: String(phone).trim(),
        business: business ? String(business).trim() : '',
        budget: budget ? String(budget).trim() : '',
        request: request ? String(request).trim() : '',
        hasSales: hasSales ? String(hasSales).trim() : '',
        lang: lang || '',
        source: source || 'квиз',
        utm: utm || {}
      }
    };
  }

  if (type === 'lead') {
    const { name, phone, lang, source, utm } = payload;
    if (!name || !phone) return { error: 'invalid payload' };

    return {
      value: {
        type,
        name: String(name).trim(),
        phone: String(phone).trim(),
        lang: lang || '',
        source: source || '',
        utm: utm || {}
      }
    };
  }

  return { error: 'Unsupported type' };
}

function buildTelegramMessage(data) {
  const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

  if (data.type === 'quiz') {
    return (
      `📩 НОВАЯ ЗАЯВКА С САЙТА\n\n` +
      `👤 Имя: ${data.name || '—'}\n` +
      `📱 Контакт: ${data.phone || '—'}\n` +
      `🏢 Бизнес: ${data.business || '—'}\n` +
      `💰 Бюджет: ${data.budget || '—'}\n` +
      `📝 Запрос: ${data.request || '—'}\n` +
      `👥 Отдел продаж: ${data.hasSales || '—'}\n` +
      `🏷 Источник: ${data.source || '—'}\n` +
      `🕐 Время: ${now}\n` +
      `🌐 Язык: ${data.lang || '—'}`
    );
  }

  if (data.type === 'lead') {
    return (
      `🔔 Новая заявка\n\n` +
      `👤 Имя: ${data.name || '—'}\n` +
      `📱 Телефон: ${data.phone || '—'}\n` +
      `🏷 Источник: ${data.source || '—'}\n` +
      `🕐 Время: ${now}\n` +
      `🌐 Язык: ${data.lang || '—'}`
    );
  }

  return `📋 Новое сообщение\n\n${JSON.stringify(data, null, 2)}`;
}

app.post('/api/submit', async (req, res) => {
  try {
    const { value, error } = validatePayload(req.body);

    if (error) {
      return res.status(400).json({ ok: false, error });
    }

    await sendTelegramMessage(buildTelegramMessage(value));

    if (APPS_SCRIPT_URL && APPS_SCRIPT_SECRET) {
      try {
        await fetch(APPS_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({
            ...value,
            secret: APPS_SCRIPT_SECRET
          })
        });
      } catch (e) {
        console.warn('Apps Script save failed:', e.message);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;

  if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false });
  }

  const token = generateToken();
  sessions[token] = {
    createdAt: Date.now()
  };

  return res.json({ ok: true, token });
});

app.get('/admin/leads', checkAdminAuth, async (req, res) => {
  try {
    if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
      return res.status(500).json({ ok: false, error: 'Apps Script not configured' });
    }

    const url = `${APPS_SCRIPT_URL}?action=list&secret=${encodeURIComponent(APPS_SCRIPT_SECRET)}&t=${Date.now()}`;
    const r = await fetch(url);
    const data = await r.json();

    return res.json({
      ok: true,
      leads: data.leads || []
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Load error' });
  }
});

app.post('/admin/action', checkAdminAuth, async (req, res) => {
  try {
    const { type, row, phone } = req.body;

    if (!type || !row) {
      return res.status(400).json({ ok: false, error: 'Invalid request' });
    }

    if (!APPS_SCRIPT_URL || !APPS_SCRIPT_SECRET) {
      return res.status(500).json({ ok: false, error: 'Apps Script not configured' });
    }

    const payload = {
      type,
      row,
      phone: phone || '',
      secret: APPS_SCRIPT_SECRET
    };

    const r = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });

    const data = await r.json();

    return res.json({
      ok: data.ok === true
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'Action error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
