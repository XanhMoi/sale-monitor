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
    text:         lm.message || lm.text || '',
    isStaff:      lm.from?.is_page === true || lm.sender?.is_page === true,
    staffName:    lm.from?.name || lm.sender?.name || '(không rõ)',
    customerName: payload?.data?.from?.name || payload?.data?.customer?.name || '(khách)',
    customerId:   payload?.data?.from?.id   || payload?.data?.customer?.id   || '',
    convId:       payload?.data?.id || payload?.data?.conversation_id || '?',
    pageId:       payload?.page_id || '?',
    tsRaw:        lm.created_time || payload?.timestamp || null,
  };

  // Format B: message trực tiếp
  const msg = payload?.message;
  if (msg) return {
    text:         msg.text || msg.message || '',
    isStaff:      msg.sender?.is_page === true || msg.from?.is_page === true,
    staffName:    msg.sender?.name || msg.from?.name || '(không rõ)',
    customerName: payload?.customer?.name || payload?.from?.name || '(khách)',
    customerId:   payload?.customer?.id   || payload?.from?.id   || '',
    convId:       payload?.conversation_id || '?',
    pageId:       payload?.page_id || '?',
    tsRaw:        msg.created_time || null,
  };

  return null;
}

// Link thẳng vào hội thoại Pancake
function pancakeLink(pageId, convId) {
  if (!pageId || pageId === '?' || !convId || convId === '?') return null;
  return `https://pancake.vn/conversations?page_id=${pageId}&id=${convId}`;
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
    const link = pancakeLink(e.pageId, e.convId);

    const entry = {
      _ts:          Date.now(),
      time:         ts,
      staff:        e.staffName,
      customer:     e.customerName,
      customerId:   e.customerId,
      message:      e.text.slice(0, 300),
      issues,
      ok:           issues.length === 0,
      pageId:       e.pageId,
      convId:       e.convId,
      pancakeLink:  link,
    };

    alertLog.unshift(entry);
    if (alertLog.length > MAX_LOG) alertLog.pop();

    if (issues.length > 0) {
      console.log(`[⚠️  ${ts}] ${e.staffName} → ${e.customerName} | ${issues.join(' · ')}`);
      console.log(`     "${e.text.slice(0, 100)}"`);
      if (link) console.log(`     🔗 ${link}`);
    } else {
      console.log(`[✅  ${ts}] ${e.staffName} → ${e.customerName}: "${e.text.slice(0, 80)}"`);
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
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8">
    <title>Sale Monitor</title>
    <style>
      body{font-family:sans-serif;background:#0f172a;color:#e2e8f0;padding:20px;max-width:800px;margin:0 auto}
      h2{color:#10b981}
      .stat{background:#1e293b;padding:10px 16px;border-radius:8px;margin-bottom:12px;display:inline-block;margin-right:8px}
      .alert{background:#1a0a0a;border-left:3px solid #ef4444;border-radius:6px;padding:12px;margin:8px 0}
      .alert .header{font-weight:bold;margin-bottom:6px;color:#fca5a5}
      .alert .issues{color:#fbbf24;font-size:13px;margin-bottom:6px}
      .alert .msg{color:#94a3b8;font-style:italic;font-size:13px;border-left:2px solid #334155;padding-left:8px}
      .alert .link{margin-top:6px;font-size:12px}
      .alert .link a{color:#60a5fa}
      .ok{color:#10b981;font-size:13px}
      code{background:#1e293b;padding:2px 6px;border-radius:4px;color:#7dd3fc}
    </style></head><body>
    <h2>🔍 Sale Monitor</h2>
    <div class="stat">📨 Đã nhận: <b>${alertLog.length}</b> tin nhắn NV</div>
    <div class="stat">⚠️ Vi phạm SOP: <b style="color:#ef4444">${bad.length}</b></div>
    <p style="color:#64748b;font-size:13px">Webhook: <code>POST /webhook</code> &nbsp;|&nbsp; <a href="/api/alerts" style="color:#60a5fa">/api/alerts</a></p>
    <hr style="border-color:#1e293b;margin:16px 0">
    <h3 style="color:#fbbf24">⚠️ Vi phạm gần nhất</h3>
    ${bad.length === 0 ? '<p class="ok">✅ Chưa có vi phạm nào</p>' :
      bad.slice(0,10).map(a=>`
      <div class="alert">
        <div class="header">
          🕐 ${a.time} &nbsp;|&nbsp; 👤 Sale: <b>${a.staff}</b> &nbsp;→&nbsp; 👥 Khách: <b>${a.customer || '?'}</b>
        </div>
        <div class="issues">⚠️ ${a.issues.join('<br>⚠️ ')}</div>
        <div class="msg">"${a.message.slice(0,150)}"</div>
        ${a.pancakeLink ? `<div class="link">🔗 <a href="${a.pancakeLink}" target="_blank">Mở hội thoại trong Pancake →</a></div>` : ''}
      </div>`).join('')
    }
  </body></html>`);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔍 Sale Monitor: http://localhost:${PORT}`);
  console.log(`📡 Webhook: POST /webhook`);
  console.log(`📊 Alerts:  GET  /api/alerts\n`);
});
