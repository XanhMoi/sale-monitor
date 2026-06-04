// ─────────────────────────────────────────────────────────────────────────────
// Sale Monitor — Pancake Webhook Quality Checker
// Nhận webhook từ Pancake, đánh giá chất lượng tin nhắn nhân viên theo SOP
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── STORAGE ──────────────────────────────────────────────────────────────────
const alertLog = []; // tối đa 500 entries, mới nhất đầu
const rawLog   = []; // 20 raw payloads đầu tiên để debug format Pancake
const MAX_LOG  = 500;

// ─── QUALITY CHECK theo SOP ───────────────────────────────────────────────────
function checkQuality(text) {
  const t = (text || '').trim();
  if (!t || t.length === 0) return [];
  const issues = [];

  // 1. Thiếu "dạ" — bắt buộc trong mọi tin nhắn nhân viên
  if (!/\bdạ\b/i.test(t)) {
    issues.push('Thiếu "dạ" — không đúng quy chuẩn hành văn SOP');
  }

  // 2. Quá ngắn / hời hợt
  if (t.length < 30) {
    issues.push(`Tin quá ngắn (${t.length} ký tự) — có thể hời hợt`);
  }

  // 3. Viết tắt / teencode
  if (/\b(ko\b|k\b|dc\b|đc\b|cx\b|mk\b|hok\b|ntn\b|oke\b|vs\b)\b/i.test(t)) {
    issues.push('Dùng viết tắt / teencode — vi phạm quy định văn phong');
  }

  // 4. Cộc lốc 1 từ
  if (/^(ok|oke|được|nhé|vâng|đúng|xem|hiểu|vậy|à|ừ|uh|ha|he|ừm)\.?\s*$/i.test(t)) {
    issues.push('Trả lời cộc lốc — không đúng quy trình (dạ + chủ vị + vị ngữ)');
  }

  // 5. Chỉ báo giá, không giải thích ưu điểm
  if (/^[\d.,\s]+(k|đ|vnd|triệu|tr)?\.?\s*$/i.test(t)) {
    issues.push('Chỉ báo giá — thiếu ưu điểm SP và tạo khan hiếm theo SOP');
  }

  return issues;
}

// ─── EXTRACT MESSAGE từ nhiều format Pancake webhook ─────────────────────────
function extractMsg(payload) {
  // Format A: data.last_message (phổ biến nhất)
  const lm = payload?.data?.last_message;
  if (lm) return {
    text:      lm.message || lm.text || '',
    isStaff:   lm.from?.is_page === true || lm.sender?.is_page === true,
    staffName: lm.from?.name || lm.sender?.name || '(không rõ)',
    convId:    payload?.data?.id || '?',
    pageId:    payload?.page_id || '?',
    tsRaw:     lm.created_time || payload?.timestamp || null,
  };

  // Format B: message trực tiếp
  const msg = payload?.message;
  if (msg) return {
    text:      msg.text || msg.message || '',
    isStaff:   msg.sender?.is_page === true || msg.from?.is_page === true,
    staffName: msg.sender?.name || msg.from?.name || '(không rõ)',
    convId:    payload?.conversation_id || '?',
    pageId:    payload?.page_id || '?',
    tsRaw:     msg.created_time || null,
  };

  return null;
}

function vnTime() {
  return new Date(Date.now() + 7 * 3600 * 1000).toLocaleTimeString('vi-VN');
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Health check + Pancake webhook verification (GET challenge)
app.get('/webhook', (req, res) => {
  const challenge = req.query['hub.challenge'];
  if (challenge) return res.send(challenge);
  res.json({ status: 'Sale Monitor active', alerts: alertLog.filter(e => !e.ok).length });
});

// Nhận Pancake webhook events
app.post('/webhook', express.text({ type: 'text/*', limit: '2mb' }), (req, res) => {
  res.sendStatus(200); // trả lời ngay — Pancake không chờ

  let payloads;
  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const parsed = JSON.parse(raw);
    payloads = Array.isArray(parsed) ? parsed : [parsed];
  } catch { return; }

  if (rawLog.length < 20) rawLog.push({ ts: vnTime(), payload: payloads[0] });

  for (const payload of payloads) {
    const e = extractMsg(payload);
    if (!e || !e.isStaff || !e.text.trim()) continue;

    const issues = checkQuality(e.text);
    const ts = vnTime();

    const entry = {
      _ts:     Date.now(),
      time:    ts,
      staff:   e.staffName,
      message: e.text.slice(0, 300),
      issues,
      ok:      issues.length === 0,
      pageId:  e.pageId,
      convId:  e.convId,
    };

    alertLog.unshift(entry);
    if (alertLog.length > MAX_LOG) alertLog.pop();

    if (issues.length > 0) {
      console.log(`[⚠️  ${ts}] ${e.staffName} | ${issues.join(' · ')}`);
      console.log(`     "${e.text.slice(0, 100)}"`);
    } else {
      console.log(`[✅  ${ts}] ${e.staffName}: "${e.text.slice(0, 80)}"`);
    }
  }
});

// Poll alerts — Claude session dùng để báo cáo
app.get('/api/alerts', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  const allBad = alertLog.filter(e => !e.ok);
  const newBad = since ? allBad.filter(e => e._ts > since) : allBad.slice(0, 50);
  res.json({
    totalMessages: alertLog.length,
    totalAlerts:   allBad.length,
    newAlerts:     newBad,
    recent:        alertLog.slice(0, 10),
    rawSample:     rawLog[0] || null,
    serverTime:    vnTime(),
  });
});

app.get('/api/alerts/clear', (_req, res) => {
  alertLog.length = 0;
  res.json({ ok: true });
});

// Trang chủ
app.get('/', (_req, res) => {
  const bad = alertLog.filter(e => !e.ok);
  res.send(`
    <h2>🔍 Sale Monitor</h2>
    <p>Webhook: <code>POST /webhook</code></p>
    <p>Đã nhận: <b>${alertLog.length}</b> tin nhắn nhân viên | ⚠️ Cảnh báo: <b>${bad.length}</b></p>
    <p>API: <a href="/api/alerts">/api/alerts</a></p>
    ${bad.slice(0,5).map(a=>`<div style="background:#1a0a0a;padding:8px;margin:4px;border-left:3px solid #f55">
      <b>${a.time} — ${a.staff}</b><br>
      ${a.issues.join('<br>')}:<br>
      <i>"${a.message.slice(0,120)}"</i>
    </div>`).join('')}
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔍 Sale Monitor: http://localhost:${PORT}`);
  console.log(`📡 Webhook: POST /webhook`);
  console.log(`📊 Alerts:  GET  /api/alerts\n`);
});
