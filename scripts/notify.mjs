// GitHub Actions tarafından birkaç dakikada bir çalıştırılır:
// 1) Telegram'dan gelen /start, /liste ve "✅ Yaptım" basışlarını işler.
// 2) Önceliğine göre zamanı gelen görevler için hatırlatma gönderir.
// Durum (sohbet, son hatırlatmalar, tamamlananlar) data dalındaki state.json'da tutulur.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PASS = process.env.TASKS_PASSWORD;
const DATA_DIR = process.env.DATA_DIR || 'data';
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || '').split('/');
const PAGE_URL = REPO ? `https://${OWNER.toLowerCase()}.github.io/${REPO}/` : '';
if (!TOKEN || !PASS) {
  console.error("TELEGRAM_BOT_TOKEN ve TASKS_PASSWORD secret'ları tanımlı olmalı.");
  process.exit(1);
}

const PRI = {
  1: { emoji: '🔴', every: 'bitene kadar saatte bir' },
  2: { emoji: '🟠', every: '3 saatte bir' },
  3: { emoji: '🟡', every: 'günde bir' },
  4: { emoji: '🔵', every: '2 günde bir' },
  5: { emoji: '⚪', every: 'haftada bir' },
};

// ---------- Zamanlama (index.html ile aynı olmalı) ----------
const TZ_OFFSET = 3 * 3600e3;            // Türkiye, UTC+3
const WINDOW = {                          // mesaj gelebilecek gün (0=Pazar) ve saatler
  is: { days: [1, 2, 3, 4, 5], start: 8, end: 18 },
  ev: { days: [0, 1, 2, 3, 4, 5, 6], start: 8, end: 22 },
};
const DAILY_HOUR = 9;                    // günlük/haftalık hatırlatma saati
const HOURS = { 1: 1, 2: 3 };
const DAYS = { 3: 1, 4: 2, 5: 7 };
const TOLERANCE = 7 * 60e3;              // cron gecikmelerini tolere eder
const trHour = ms => new Date(ms + TZ_OFFSET).getUTCHours();
const trWeekday = ms => new Date(ms + TZ_OFFSET).getUTCDay();
const trDay = ms => Math.floor((ms + TZ_OFFSET) / 86400e3);
const lastOf = (t, note) => Date.parse(note?.last || t.created);
const windowOf = t => WINDOW[t.cat] || WINDOW.ev;

function isDue(t, note, now) {
  const w = windowOf(t), h = trHour(now);
  if (!w.days.includes(trWeekday(now)) || h < w.start || h >= w.end) return false;
  const last = lastOf(t, note);
  if (HOURS[t.pri]) return now - last >= HOURS[t.pri] * 3600e3 - TOLERANCE;
  return h >= DAILY_HOUR && trDay(now) - trDay(last) >= DAYS[t.pri];
}

// ---------- Şifreleme (index.html ile aynı olmalı) ----------
const enc = new TextEncoder(), dec = new TextDecoder();
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function decryptJSON(blob, pass) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: unb64(blob.salt), iterations: 250000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.data));
  return JSON.parse(dec.decode(plain));
}

// ---------- Telegram ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) console.log(`Telegram ${method}: ${j.description}`);
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const where = t => (t.cat === 'is' ? '💼 İş' : '🏠 Ev') + (t.project ? ` · 📁 <b>${esc(t.project)}</b>` : '');
const byPriority = (a, b) => a.pri - b.pri || a.created.localeCompare(b.created);

function reminderText(t) {
  return [
    `${PRI[t.pri].emoji} <b>Öncelik ${t.pri}</b> · ${where(t)}`,
    '',
    `📝 ${esc(t.title)}`,
    ...(t.note ? [`🗒 <i>${esc(t.note)}</i>`] : []),
    '',
    `<i>Bunu yaptın mı? (${PRI[t.pri].every} hatırlatıyorum)</i>`,
  ].join('\n');
}
function reminderButtons(t) {
  const row = [{ text: '✅ Yaptım', callback_data: `d:${t.id}` }];
  if (PAGE_URL) row.push({ text: '📋 Liste', url: PAGE_URL });
  return { inline_keyboard: [row] };
}
function listText(open) {
  if (!open.length) return '🎉 Açık görev yok.';
  return [`📋 <b>Açık görevler (${open.length})</b>`, '',
    ...open.map(t => `${PRI[t.pri].emoji} ${where(t)}\n    ${esc(t.title)}`)].join('\n');
}

// ---------- Ana akış ----------
const statePath = join(DATA_DIR, 'state.json');
const tasksPath = join(DATA_DIR, 'tasks.json');
const state = { chatId: null, offset: 0, done: [], notes: {}, ...JSON.parse(await readFile(statePath, 'utf8').catch(() => '{}')) };
const before = JSON.stringify(state);
const now = Date.now();
const today = new Date(now + TZ_OFFSET).toISOString().slice(0, 10);

let tasks = [], tasksOk = true;
const raw = await readFile(tasksPath, 'utf8').catch(() => null);
if (raw) {
  try { tasks = await decryptJSON(JSON.parse(raw), PASS); }
  catch (e) { tasksOk = false; console.error('tasks.json çözülemedi (şifre farklı olabilir):', e.message); }
}
const done = new Set(state.done);
const byId = new Map(tasks.map(t => [t.id, t]));
const openTasks = () => tasks.filter(t => !done.has(t.id)).sort(byPriority);

// 1) Telegram güncellemeleri
const updates = await tg('getUpdates', { offset: state.offset, timeout: 0, allowed_updates: ['message', 'callback_query'] });
if (!updates.ok) {
  console.error(`Telegram'a bağlanılamadı (${updates.description}). TELEGRAM_BOT_TOKEN secret'ını kontrol edin.`);
  process.exit(1);
}
console.log(`Telegram'dan ${updates.result.length} yeni güncelleme alındı.`);
for (const u of updates.result || []) {
  state.offset = u.update_id + 1;
  if (u.message) {
    const chat = u.message.chat.id, text = (u.message.text || '').trim();
    if (!state.chatId && text.startsWith('/start')) {
      state.chatId = chat;
      await tg('sendMessage', { chat_id: chat, text: '✅ Bağlandı! Hatırlatmalar artık buraya gelecek.\n\n/liste — açık görevleri gösterir' });
      continue;
    }
    if (chat !== state.chatId) continue; // bot yalnızca sahibine çalışır
    if (text.startsWith('/liste')) {
      await tg('sendMessage', {
        chat_id: chat, parse_mode: 'HTML', text: listText(openTasks()),
        ...(PAGE_URL && { reply_markup: { inline_keyboard: [[{ text: '📋 Listeyi aç', url: PAGE_URL }]] } }),
      });
    } else if (text.startsWith('/start')) {
      await tg('sendMessage', { chat_id: chat, text: 'Zaten bağlısın ✅  /liste ile açık görevleri görebilirsin.' });
    }
  } else if (u.callback_query) {
    const q = u.callback_query, chat = q.message?.chat.id;
    const m = /^d:(.+)$/.exec(q.data || '');
    if (chat !== state.chatId || !m) continue;
    const id = m[1], t = byId.get(id);
    done.add(id);
    delete state.notes[id];
    await tg('answerCallbackQuery', { callback_query_id: q.id, text: 'Tamamlandı ✅' });
    await tg('editMessageText', {
      chat_id: chat, message_id: q.message.message_id, parse_mode: 'HTML',
      text: `✅ <s>${esc(t?.title || 'Görev')}</s>\nTamamlandı, listeden çıkarıldı.`,
    });
  }
}

// 2) Hatırlatmalar
state.done = [...done];
if (!tasksOk) {
  if (state.chatId && state.warned !== today) {
    await tg('sendMessage', { chat_id: state.chatId, text: "⚠️ Görevler okunamadı. Sayfadaki görev şifresi ile GitHub'daki TASKS_PASSWORD aynı olmalı." });
    state.warned = today;
  }
} else {
  // Sayfadan silinmiş görevlerin kayıtlarını temizle
  state.done = state.done.filter(id => byId.has(id));
  for (const id of Object.keys(state.notes)) if (!byId.has(id) || done.has(id)) delete state.notes[id];

  if (state.chatId) {
    for (const t of openTasks().filter(t => isDue(t, state.notes[t.id], now))) {
      const old = state.notes[t.id]?.msg;
      const r = await tg('sendMessage', { chat_id: state.chatId, parse_mode: 'HTML', text: reminderText(t), reply_markup: reminderButtons(t) });
      if (!r.ok) continue;
      if (old) await tg('deleteMessage', { chat_id: state.chatId, message_id: old }); // sohbette her görevin yalnızca son hatırlatması kalsın
      state.notes[t.id] = { last: new Date(now).toISOString(), msg: r.result.message_id };
      await sleep(400);
    }
  } else {
    console.log("Henüz bağlı sohbet yok: Telegram'da bota /start yazın.");
  }
}

state.heartbeat = today; // günde bir commit, zamanlanmış iş 60 gün sonra kapanmasın
if (JSON.stringify(state) !== before) await writeFile(statePath, JSON.stringify(state, null, 1) + '\n');
console.log(`Açık görev: ${tasksOk ? openTasks().length : '?'}, bağlı sohbet: ${state.chatId ? 'var' : 'yok'}`);
