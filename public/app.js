const ATTACH = new Set([',', ';', ':', '-', "'"]);
const TERM = new Set(['.', '!', '?']);

const form = document.getElementById('composer');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const transcript = document.getElementById('transcript');
const howDialog = document.getElementById('how-dialog');
const howOpen = document.getElementById('how-open');
const howClose = document.getElementById('how-close');
const TEMPERATURE = 0.3;

howOpen.addEventListener('click', () => howDialog.showModal());
howClose.addEventListener('click', () => howDialog.close());
howDialog.addEventListener('click', (event) => {
  if (event.target === howDialog) howDialog.close();
});

const messages = [];
let busy = false;

function scroll() {
  transcript.scrollTop = transcript.scrollHeight;
}

function addTurn(role) {
  const turn = document.createElement('div');
  turn.className = `turn ${role}`;
  const label = document.createElement('div');
  label.className = 'role';
  label.textContent = role === 'user' ? 'you' : 'jev';
  const text = document.createElement('div');
  text.className = 'text';
  turn.append(label, text);
  transcript.append(turn);
  scroll();
  return text;
}

function isPunct(t) {
  return ATTACH.has(t) || TERM.has(t);
}

function appendWord(container, caret, ev) {
  const span = document.createElement('span');
  span.className = 'w' + (isPunct(ev.word) ? ' punct' : '');
  span.textContent = ev.word;
  span._alts = ev.alts;
  span._p = ev.p;
  if (typeof ev.p === 'number') {
    span.style.setProperty('--p', String(Math.min(1, ev.p * 3)));
  }
  container.insertBefore(span, caret);
}

/* hover a word to see what else Jev was considering */
const tip = document.getElementById('tip');
let hideTimer = null;

function hideTip() {
  tip.hidden = true;
}

function showTip(span) {
  const alts = Array.isArray(span._alts) ? span._alts : [];
  const chosen = span.textContent;
  const hasP = typeof span._p === 'number';
  const chosenEntry = hasP
    ? [chosen, span._p]
    : alts.find(([w]) => w === chosen);
  const others = alts.filter(([w]) => w !== chosen).slice(0, 7);
  const rows = (chosenEntry ? [chosenEntry, ...others] : others).sort(
    (a, b) => b[1] - a[1],
  );
  if (!rows.length) return;
  const max = Math.max(...rows.map(([, p]) => p), 1e-4);

  tip.innerHTML = '<div class="tip-head">considered next</div>';
  for (const [w, p] of rows) {
    const row = document.createElement('div');
    row.className = 'row' + (w === chosen ? ' chosen' : '');
    const label = document.createElement('span');
    label.textContent = w;
    const bar = document.createElement('span');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(5, (p / max) * 100)}%`;
    bar.append(fill);
    const prob = document.createElement('span');
    prob.className = 'p';
    prob.textContent = p.toFixed(2);
    row.append(label, bar, prob);
    tip.append(row);
  }

  tip.hidden = false;
  tip.style.left = '-9999px';
  const r = span.getBoundingClientRect();
  const tw = tip.offsetWidth;
  const th = tip.offsetHeight;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
  let top = r.top - th - 8;
  if (top < 8) top = r.bottom + 8;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

transcript.addEventListener('mouseover', (e) => {
  const w = e.target instanceof Element ? e.target.closest('.w') : null;
  if (!w || !w._alts) return;
  clearTimeout(hideTimer);
  showTip(w);
});
transcript.addEventListener('mouseout', (e) => {
  const w = e.target instanceof Element ? e.target.closest('.w') : null;
  if (!w) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideTip, 40);
});
transcript.addEventListener('scroll', hideTip, { passive: true });
window.addEventListener('resize', hideTip);

async function streamReply(container, caret) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, temperature: TEMPERATURE }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`server ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let end = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 2);
      if (!chunk.startsWith('data:')) continue;
      let ev;
      try {
        ev = JSON.parse(chunk.slice(5).trim());
      } catch {
        continue;
      }
      if (ev.type === 'word') {
        appendWord(container, caret, ev);
        scroll();
      } else if (ev.type === 'end') {
        end = ev;
      } else if (ev.type === 'error') {
        throw new Error(ev.message);
      }
    }
  }
  return end;
}

async function send(text) {
  if (busy || !text.trim()) return;
  busy = true;
  form.classList.add('busy');
  sendBtn.disabled = true;

  document.getElementById('empty')?.remove();

  messages.push({ role: 'user', text });
  addTurn('user').textContent = text;
  input.value = '';

  const container = addTurn('assistant');
  const caret = document.createElement('span');
  caret.className = 'caret';
  container.append(caret);

  try {
    const end = await streamReply(container, caret);
    caret.remove();
    if (end) {
      messages.push({ role: 'assistant', text: end.text });
      const meta = document.createElement('div');
      meta.className = 'turnmeta';
      const over = end.endProbability >= 0.6;
      meta.innerHTML =
        `end-of-chat ${end.endProbability.toFixed(2)} · ` +
        `${end.inputTokens.toLocaleString()} tok · $${end.costUsd.toFixed(5)}` +
        (over ? ' <span class="over">· jev thinks this chat is over</span>' : '');
      container.parentElement.append(meta);
    }
  } catch (err) {
    caret.remove();
    container.textContent = `— ${err.message}`;
  } finally {
    busy = false;
    form.classList.remove('busy');
    sendBtn.disabled = false;
    scroll();
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  send(input.value);
});

function start() {
  transcript.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => send(chip.dataset.say));
  });
  input.focus();
}

start();
