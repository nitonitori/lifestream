'use strict';
const $ = id => document.getElementById(id);
let unauthShown = false;
async function api(path, opts) {
  const r = await fetch(path, { credentials: 'same-origin', headers: { 'content-type': 'application/json' }, ...opts });
  if (r.status === 401 && path !== '/api/login') handleUnauth();
  return r;
}
function handleUnauth() {
  if (unauthShown) return;
  unauthShown = true;
  $('devicesModal').classList.remove('is-open');
  $('app').classList.remove('is-ready');
  $('login').style.display = 'grid';
  $('loginErr').textContent = '会话已失效，请重新登录。';
}

const MAX_RENDER = 300;   // 窗口化：DOM 中最多渲染的消息数
const CHUNK = 200;        // “载入更早”每次追加
const MESSENGER = { kind: 'messenger', id: null };

const state = {
  agentEnabled: false,
  sessions: new Map(),           // sessionId -> summary
  current: null,                 // { kind, id }
  events: [],                    // 当前 stream 的全部已知事件
  renderedKeys: new Set(),       // 已渲染事件 key
  windowStart: 0,                // 窗口起点索引
  pending: [],                   // 信使待确认动作
  messengerTimer: null,
};

/* ---------------- boot ---------------- */
async function init() {
  const r = await api('/api/agent/enabled');
  if (r.status === 401) { showLogin(); return; }
  const j = await r.json().catch(() => ({ enabled: false }));
  state.agentEnabled = !!j.enabled;
  boot();
}
function showLogin() { $('login').style.display = 'grid'; }
async function doLogin() {
  const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ token: $('token').value }) });
  if (r.status === 204) { location.reload(); }
  else { $('loginErr').textContent = '令牌无效，请重试。'; }
}

function boot() {
  $('login').style.display = 'none';
  $('app').classList.add('is-ready');
  refreshSessions();
  connectStream();
  if (state.agentEnabled) selectStream(MESSENGER);
}

/* ---------------- sessions + rail ---------------- */
async function refreshSessions() {
  const r = await api('/api/sessions');
  if (!r.ok) return;
  const list = await r.json();
  state.sessions = new Map(list.map(s => [s.sessionId, s]));
  renderRail();
}

function fleetCounts() {
  let busy = 0, idle = 0;
  for (const s of state.sessions.values()) {
    if (!s.live) continue;
    if (s.status === 'busy') busy++;
    else if (s.status === 'idle') idle++;
    // status 未知（如旧版本 claude 不写 status）：既非忙也非闲，不计入，仅在列表标为“在线”
  }
  return { busy, idle };
}

function renderRail() {
  const wrap = $('streams');
  wrap.innerHTML = '';
  const { busy, idle } = fleetCounts();
  $('cntBusy').textContent = busy;
  $('cntIdle').textContent = idle;

  if (state.agentEnabled) {
    wrap.appendChild(streamCard({
      kind: 'messenger', name: '信使 Agent', meta: '与 IM 共享上下文', vital: 'brand', tag: 'AGENT',
    }));
  }

  const sessions = [...state.sessions.values()];
  if (sessions.length === 0 && !state.agentEnabled) {
    const e = document.createElement('div');
    e.className = 'rail__empty';
    e.textContent = '还没有运行中的 Claude 会话。';
    wrap.appendChild(e);
    return;
  }
  for (const s of sessions) {
    const vital = !s.live ? 'external' : (s.status === 'busy' ? 'busy' : s.status === 'idle' ? 'idle' : 'live');
    wrap.appendChild(streamCard({
      kind: 'session', id: s.sessionId,
      name: s.name || s.sessionId.slice(0, 8),
      meta: s.cwd || '—',
      vital, tag: s.controllable ? '可控' : (s.live ? '外部' : '离线'),
      ctl: s.controllable,
    }));
  }
}

function streamCard(o) {
  const el = document.createElement('div');
  el.className = 'stream' + (o.kind === 'messenger' ? ' stream--pin' : '');
  const isActive = state.current && state.current.kind === o.kind && (o.kind === 'messenger' || state.current.id === o.id);
  if (isActive) el.classList.add('is-active');
  const dotClass = o.vital === 'brand' ? 'is-idle' : `is-${o.vital}`;
  el.innerHTML =
    `<div class="stream__vital"><span class="vital-dot ${dotClass}"></span></div>
     <div class="stream__body">
       <div class="stream__name"></div>
       <div class="stream__meta mono"></div>
     </div>
     <span class="stream__tag${o.ctl ? ' is-ctl' : ''}"></span>`;
  el.querySelector('.stream__name').textContent = o.name;
  el.querySelector('.stream__meta').textContent = o.meta;
  el.querySelector('.stream__tag').textContent = o.tag;
  el.onclick = () => selectStream(o.kind === 'messenger' ? MESSENGER : { kind: 'session', id: o.id });
  return el;
}

/* ---------------- stream selection ---------------- */
async function selectStream(sel) {
  state.current = sel;
  if (state.messengerTimer) { clearInterval(state.messengerTimer); state.messengerTimer = null; }
  renderRail();
  $('placeholder').style.display = 'none';
  $('consoleView').style.display = 'flex';
  $('app').classList.add('show-console');
  renderHeader();
  $('confirmBox').style.display = 'none';

  await loadStreamMessages(true);

  if (sel.kind === 'messenger') {
    await loadPending();
    state.messengerTimer = setInterval(() => { if (state.current && state.current.kind === 'messenger') loadStreamMessages(false); }, 5000);
  }
}

function renderHeader() {
  const sel = state.current;
  const actions = $('cvActions');
  actions.innerHTML = '';
  if (sel.kind === 'messenger') {
    $('cvName').textContent = '信使 Agent';
    $('cvSub').textContent = '与钉钉共享同一会话上下文';
    $('composerInput').placeholder = '对信使 Agent 说…（变更操作会先请你确认）';
  } else {
    const s = state.sessions.get(sel.id);
    $('cvName').textContent = (s && s.name) || sel.id.slice(0, 8);
    $('cvSub').textContent = s ? `${statusLabel(s)} · ${s.cwd}` : sel.id;
    $('composerInput').placeholder = s && s.controllable ? '发送消息到该会话…' : '该会话未托管，先接管才能发送';
    if (s && !s.controllable && s.live) {
      const b = document.createElement('button');
      b.className = 'btn btn--ghost'; b.textContent = '接管';
      b.onclick = () => adopt(sel.id);
      actions.appendChild(b);
    }
    if (s && s.controllable) {
      const del = document.createElement('button');
      del.className = 'btn btn--ghost'; del.textContent = '结束会话';
      del.onclick = () => archiveSession(sel.id);
      actions.appendChild(del);
    }
  }
  const refresh = document.createElement('button');
  refresh.className = 'btn btn--ghost'; refresh.textContent = '刷新';
  refresh.onclick = () => loadStreamMessages(true);
  actions.appendChild(refresh);
}

function statusLabel(s) {
  if (!s.live) return '离线';
  return s.status === 'busy' ? '运行中' : s.status === 'idle' ? '空闲' : '在线';
}

async function loadStreamMessages(reset) {
  const sel = state.current;
  const url = sel.kind === 'messenger' ? '/api/agent/messages' : `/api/sessions/${sel.id}/messages`;
  const r = await api(url);
  if (!r.ok) { if (reset) setEvents([], true); return; }
  const events = await r.json();
  setEvents(events, reset);
}

/* ---------------- message rendering (windowed + smart scroll) ---------------- */
function setEvents(events, reset) {
  const view = $('streamView');
  const wasBottom = atBottom(view);
  if (reset) {
    state.events = events;
    state.renderedKeys = new Set();
    $('messages').innerHTML = '';
    state.windowStart = Math.max(0, events.length - MAX_RENDER);
    for (let i = state.windowStart; i < events.length; i++) appendNode(events[i]);
    $('loadMore').style.display = state.windowStart > 0 ? 'block' : 'none';
    if (!renderedAny()) showEmptyHint();
    jumpToBottomInstant(view);   // 切换会话：直接展示最新，不做滚动动画
    hideJump();
    return;
  }
  // incremental: append only unseen
  let added = 0;
  for (const e of events) {
    const key = eventKey(e);
    if (!key || state.renderedKeys.has(key)) continue;
    state.events.push(e);
    appendNode(e);
    added++;
  }
  if (added === 0) return;
  if (wasBottom) view.scrollTop = view.scrollHeight;
  else bumpJump(added);
}

function pushEvent(e) { // from SSE for current session
  const key = eventKey(e);
  if (!key || state.renderedKeys.has(key)) return;
  const view = $('streamView');
  const wasBottom = atBottom(view);
  state.events.push(e);
  appendNode(e);
  if (wasBottom) view.scrollTop = view.scrollHeight; else bumpJump(1);
}

function eventKey(e) { return e.uuid || null; }

function renderedAny() { return $('messages').childElementCount > 0; }
function showEmptyHint() {
  const sel = state.current;
  const el = document.createElement('div');
  el.className = 'rail__empty';
  el.style.marginTop = '40px';
  if (sel && sel.kind === 'messenger') {
    el.textContent = '还没有对话。向信使 Agent 发消息即可开始 —— 它与钉钉共享同一上下文。';
  } else {
    const s = sel && state.sessions.get(sel.id);
    el.textContent = (s && s.live && s.controllable)
      ? '会话已启动，发送首条消息开始对话。'
      : '还没有消息。';
  }
  $('messages').appendChild(el);
}

function appendNode(e) {
  const hint = $('messages').querySelector('.rail__empty');
  if (hint) hint.remove();
  for (const node of buildNodes(e)) {
    if (node) $('messages').appendChild(node);
  }
  const k = eventKey(e);
  if (k) state.renderedKeys.add(k);
}

function buildNodes(e) {
  if (e.kind === 'user') return [bubble('user', '你', e.text)];
  if (e.kind === 'assistant') {
    const nodes = [];
    if (e.text && e.text.trim()) nodes.push(bubble('agent', 'Agent', e.text));
    for (const t of (e.toolUses || [])) nodes.push(trace('tool', `调用 ${t.name}`, safeJson(t.input), false));
    return nodes;
  }
  if (e.kind === 'tool_result') return [trace('result', '工具结果', e.content, e.isError)];
  return []; // meta hidden
}

function bubble(role, label, text) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg--${role}`;
  const b = document.createElement('div');
  b.className = 'msg__bubble';
  const r = document.createElement('span');
  r.className = 'msg__role'; r.textContent = label;
  const body = document.createElement('span');
  body.textContent = text;
  b.appendChild(r); b.appendChild(body);
  wrap.appendChild(b);
  return wrap;
}

function trace(variant, head, body, isError) {
  const el = document.createElement('div');
  el.className = `trace trace--${variant} is-collapsed` + (isError ? ' is-error' : '');
  const h = document.createElement('div');
  h.className = 'trace__head'; h.textContent = head + ' ▸';
  const b = document.createElement('div');
  b.className = 'trace__body'; b.textContent = body;
  h.onclick = () => {
    el.classList.toggle('is-collapsed');
    h.textContent = head + (el.classList.contains('is-collapsed') ? ' ▸' : ' ▾');
  };
  el.appendChild(h); el.appendChild(b);
  return el;
}

function safeJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }

/* ---------------- windowing: load earlier ---------------- */
function loadEarlier() {
  const view = $('streamView');
  const prevH = view.scrollHeight;
  const start = Math.max(0, state.windowStart - CHUNK);
  const frag = document.createDocumentFragment();
  const msgs = $('messages');
  for (let i = start; i < state.windowStart; i++) {
    for (const node of buildNodes(state.events[i])) if (node) frag.appendChild(node);
    const k = eventKey(state.events[i]); if (k) state.renderedKeys.add(k);
  }
  msgs.insertBefore(frag, msgs.firstChild);
  state.windowStart = start;
  $('loadMore').style.display = start > 0 ? 'block' : 'none';
  view.scrollTop = view.scrollHeight - prevH; // 保持视口位置
}

/* ---------------- smart scroll helpers ---------------- */
function atBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 48; }
function jumpToBottomInstant(el) {
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop = el.scrollHeight;
  el.style.scrollBehavior = prev;
}
let jumpCount = 0;
function bumpJump(n) { jumpCount += n; $('jumpCount').textContent = jumpCount; $('jump').classList.add('is-shown'); }
function hideJump() { jumpCount = 0; $('jump').classList.remove('is-shown'); }

/* ---------------- composer / actions ---------------- */
async function send() {
  const input = $('composerInput');
  const text = input.value.trim();
  if (!text || !state.current) return;
  input.value = ''; autoGrow();
  if (state.current.kind === 'messenger') {
    pushLocalUser(text);
    const r = await api('/api/agent/message', { method: 'POST', body: JSON.stringify({ text }) });
    if (!r.ok) { toast('发送失败'); return; }
    const res = await r.json();
    // staged/reply 的文本已进入信使转录：整体重载对齐，去除乐观气泡重复
    await loadStreamMessages(true);
    // executed/cancelled/expired 是控制器动作结果，不在转录里，重载后补渲染并停留在信使会话
    handleAgentResult(res);
  } else {
    const r = await api(`/api/sessions/${state.current.id}/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    if (r.status === 202) { pushLocalUser(text); toast('已发送到会话'); }
    else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '发送失败'); }
  }
}

function pushLocalUser(text) {
  const view = $('streamView');
  const hint = $('messages').querySelector('.rail__empty');
  if (hint) hint.remove();
  const b = bubble('user', '你', text);
  $('messages').appendChild(b);
  view.scrollTop = view.scrollHeight;
}

function handleAgentResult(res) {
  if (res.kind === 'staged') { showConfirm(res.actions); }
  else if (res.kind === 'reply') { /* 回复文本已在信使转录中，重载后即可见 */ }
  else if (res.kind === 'executed') { hideConfirm(); appendStatus((res.results || []).join('\n') || '已执行'); }
  else if (res.kind === 'cancelled') { hideConfirm(); appendStatus('已取消。'); }
  else if (res.kind === 'expired') { hideConfirm(); appendStatus('确认已超时，请重新发起。'); }
}
function appendStatus(text) {
  const hint = $('messages').querySelector('.rail__empty');
  if (hint) hint.remove();
  $('messages').appendChild(bubble('system', '系统', text));
  scrollBottom();
}

async function loadPending() {
  const r = await api('/api/agent/pending');
  if (!r.ok) return;
  const list = await r.json();
  if (list.length) showConfirm(list); else hideConfirm();
}
function showConfirm(actions) {
  state.pending = actions;
  const ul = $('confirmList'); ul.innerHTML = '';
  for (const a of actions) { const li = document.createElement('li'); li.textContent = a.description; ul.appendChild(li); }
  $('confirmBox').style.display = 'block';
}
function hideConfirm() { state.pending = []; $('confirmBox').style.display = 'none'; }
async function confirmDecision(word) {
  const r = await api('/api/agent/message', { method: 'POST', body: JSON.stringify({ text: word }) });
  hideConfirm();
  if (!r.ok) { toast('操作失败'); return; }
  const res = await r.json();
  await loadStreamMessages(true);
  handleAgentResult(res);
}

async function adopt(id) {
  const s = state.sessions.get(id);
  const label = (s && s.name) || id.slice(0, 8);
  let force = false;
  if (s && s.live) {
    if (!confirm(`会话「${label}」仍在运行。接管会先结束其原进程，再在受控窗口中恢复（保留完整上下文）。是否继续？`)) return;
    force = true;
  }
  const r = await api(`/api/sessions/${id}/adopt`, { method: 'POST', body: JSON.stringify({ force }) });
  if (r.ok) { toast('已接管'); refreshSessions(); renderHeader(); }
  else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '接管失败'); }
}

async function archiveSession(id) {
  const s = state.sessions.get(id);
  const label = (s && s.name) || id.slice(0, 8);
  if (!confirm(`结束会话「${label}」？这会关闭其 tmux 窗口并结束对应的 Claude 进程。`)) return;
  const r = await api(`/api/sessions/${id}`, { method: 'DELETE' });
  if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '结束失败'); return; }
  toast('已结束会话');
  state.sessions.delete(id);
  if (state.current && state.current.kind === 'session' && state.current.id === id) {
    state.current = null;
    $('consoleView').style.display = 'none';
    $('placeholder').style.display = 'grid';
    $('app').classList.remove('show-console');
  }
  refreshSessions();
}

async function newSession() {
  const cwd = prompt('新会话工作目录（cwd）');
  if (!cwd) return;
  const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd }) });
  if (r.ok) { toast('已创建'); refreshSessions(); }
  else { const j = await r.json().catch(() => ({})); toast(j.error ? j.error.message : '创建失败'); }
}

/* ---------------- SSE ---------------- */
function connectStream() {
  const es = new EventSource('/api/stream');
  es.onopen = () => { $('conn').classList.add('is-live'); $('connText').textContent = '实时'; };
  es.onerror = () => { $('conn').classList.remove('is-live'); $('connText').textContent = '重连…'; };
  es.addEventListener('status', ev => {
    const data = JSON.parse(ev.data);
    if (Array.isArray(data)) { state.sessions = new Map(data.map(s => [s.sessionId, s])); }
    else if (data.type === 'session.updated') { state.sessions.set(data.session.sessionId, data.session); }
    else if (data.type === 'session.removed') { state.sessions.delete(data.sessionId); }
    renderRail();
  });
  es.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (state.current && state.current.kind === 'session' && m.sessionId === state.current.id) pushEvent(m.event);
  });
}

/* ---------------- misc UI ---------------- */
function scrollBottom() { const v = $('streamView'); v.scrollTop = v.scrollHeight; hideJump(); }
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('is-shown');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('is-shown'), 2600);
}
function autoGrow() {
  const t = $('composerInput'); t.style.height = 'auto'; t.style.height = Math.min(160, t.scrollHeight) + 'px';
}

/* ---------------- devices ---------------- */
function relTime(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}
async function openDevices() { $('devicesModal').classList.add('is-open'); await renderDevices(); }
async function renderDevices() {
  const r = await api('/api/devices');
  if (!r.ok) return;
  const list = await r.json();
  const box = $('devicesList');
  box.innerHTML = '';
  if (!list.length) { box.innerHTML = '<div class="rail__empty">暂无设备。</div>'; return; }
  for (const d of list) {
    const el = document.createElement('div');
    el.className = 'device';
    const name = document.createElement('div');
    name.className = 'device__name';
    name.textContent = d.name;
    if (d.current) { const b = document.createElement('span'); b.className = 'cur'; b.textContent = '本机'; name.appendChild(b); }
    const meta = document.createElement('div');
    meta.className = 'device__meta';
    meta.textContent = `最近活跃 ${relTime(d.lastSeenAt)}${d.userAgent ? ' · ' + d.userAgent.slice(0, 46) : ''}`;
    const btn = document.createElement('button');
    btn.className = 'btn btn--ghost device__revoke';
    btn.textContent = d.current ? '退出' : '撤销';
    btn.onclick = () => revokeDevice(d.id, d.current);
    el.appendChild(name); el.appendChild(meta); el.appendChild(btn);
    box.appendChild(el);
  }
}
async function revokeDevice(id, isCurrent) {
  const r = await api(`/api/devices/${id}`, { method: 'DELETE' });
  if (!r.ok) { toast('撤销失败'); return; }
  if (isCurrent) { toast('已退出本设备'); handleUnauth(); }
  else { toast('已撤销'); renderDevices(); }
}
async function logout() { await api('/api/logout', { method: 'POST' }); handleUnauth(); }

/* ---------------- wire up ---------------- */
$('loginBtn').onclick = doLogin;
$('token').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
$('newBtn').onclick = newSession;
$('sendBtn').onclick = send;
$('composerInput').addEventListener('input', autoGrow);
$('composerInput').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
$('loadMore').onclick = loadEarlier;
$('jump').onclick = scrollBottom;
$('backBtn').onclick = () => { $('app').classList.remove('show-console'); };
$('confirmYes').onclick = () => confirmDecision('确认');
$('confirmNo').onclick = () => confirmDecision('取消');
$('devicesBtn').onclick = openDevices;
$('devicesClose').onclick = () => $('devicesModal').classList.remove('is-open');
$('logoutBtn').onclick = logout;
$('devicesModal').addEventListener('click', e => { if (e.target === $('devicesModal')) $('devicesModal').classList.remove('is-open'); });

init();
