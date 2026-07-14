/* Webhook Catcher dashboard — hash-routed vanilla JS, live via SSE. */

const view = document.getElementById('view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pretty = (jsonText) => {
  try { return JSON.stringify(JSON.parse(jsonText), null, 2); } catch { return jsonText ?? ''; }
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = '/login'; // session expired or not signed in
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

document.getElementById('logout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
};

const badge = (kind) => `<span class="badge ${esc(kind)}">${esc(kind)}</span>`;
const hookUrl = (slug) => `${location.origin}/hooks/${slug}`;

function copyText(text, el) {
  navigator.clipboard.writeText(text);
  const old = el.textContent;
  el.textContent = 'copied!';
  setTimeout(() => { el.textContent = old; }, 1000);
}

// ── router ───────────────────────────────────────────────────────────

const routes = [
  [/^#?\/?$/, () => renderInbox()],
  [/^#\/inbox$/, () => renderInbox()],
  [/^#\/events\/(\d+)$/, (m) => renderEvent(+m[1])],
  [/^#\/routes$/, () => renderRoutes()],
  [/^#\/routes\/new$/, () => renderRouteForm(null)],
  [/^#\/routes\/(\d+)\/edit$/, (m) => renderRouteForm(+m[1])],
  [/^#\/routes\/(\d+)\/trigger$/, (m) => renderTrigger(+m[1])],
  [/^#\/status$/, () => renderStatus()],
];

let currentPage = '';
function navigate() {
  const hash = location.hash || '#/inbox';
  for (const [re, handler] of routes) {
    const m = hash.match(re);
    if (m) {
      currentPage = hash.split('/')[1] || 'inbox';
      document.querySelectorAll('nav a').forEach((a) =>
        a.classList.toggle('active', a.dataset.nav === (currentPage === 'events' ? 'inbox' : currentPage)));
      handler(m);
      return;
    }
  }
  view.innerHTML = '<h1>Not found</h1>';
}
window.addEventListener('hashchange', navigate);

// ── live stream ──────────────────────────────────────────────────────

const source = new EventSource('/api/events/stream');
const liveDot = document.getElementById('live-dot');
source.onopen = () => liveDot.classList.add('on');
source.onerror = () => liveDot.classList.remove('on');
source.onmessage = (msg) => {
  const { type, event } = JSON.parse(msg.data);
  if (currentPage === 'inbox' || currentPage === '' ) onInboxMessage(type, event);
  if (currentPage === 'status') renderStatus();
  if (currentPage === 'events' && location.hash === `#/events/${event.id}`) renderEvent(event.id);
};

// ── inbox ────────────────────────────────────────────────────────────

let inboxFilter = '';

function eventRowHtml(e) {
  return `
    <tr class="clickable" data-id="${e.id}" onclick="location.hash='#/events/${e.id}'">
      <td class="muted">#${e.id}</td>
      <td><code>${esc(e.route_slug)}</code></td>
      <td>${badge(e.source)}</td>
      <td>${badge(e.status)}</td>
      <td class="muted">${e.attempt_count || ''}</td>
      <td class="muted">${esc(e.received_at)}</td>
    </tr>`;
}

async function renderInbox() {
  const [events, routesList] = await Promise.all([
    api(`/api/events?limit=50${inboxFilter ? `&route_id=${inboxFilter}` : ''}`),
    api('/api/routes'),
  ]);
  view.innerHTML = `
    <div class="row spread">
      <h1>Inbox</h1>
      <select id="route-filter" style="width:auto">
        <option value="">All routes</option>
        ${routesList.map((r) => `<option value="${r.id}" ${String(r.id) === inboxFilter ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      </select>
    </div>
    <div class="panel">
      <table>
        <thead><tr><th>ID</th><th>Route</th><th>Source</th><th>Status</th><th>Attempts</th><th>Received (UTC)</th></tr></thead>
        <tbody id="inbox-body">${events.map(eventRowHtml).join('') || ''}</tbody>
      </table>
      ${events.length === 0 ? `<p class="muted">No webhooks caught yet. ${routesList.length === 0 ? 'Create a route first, then' : ''} POST to a catch URL to see it appear here live.</p>` : ''}
    </div>`;
  document.getElementById('route-filter').onchange = (ev) => { inboxFilter = ev.target.value; renderInbox(); };
}

function onInboxMessage(type, e) {
  const body = document.getElementById('inbox-body');
  if (!body) return;
  if (inboxFilter && String(e.route_id) !== inboxFilter) return;
  const existing = body.querySelector(`tr[data-id="${e.id}"]`);
  const html = eventRowHtml(e);
  if (existing) {
    existing.outerHTML = html;
  } else if (type === 'event.received') {
    body.insertAdjacentHTML('afterbegin', html);
  }
  const row = body.querySelector(`tr[data-id="${e.id}"]`);
  if (row) { row.classList.add('flash'); }
}

// ── event detail ─────────────────────────────────────────────────────

function attemptHtml(a) {
  const ok = a.status_code >= 200 && a.status_code < 300;
  const label = a.error
    ? `<span class="error-text">${esc(a.error)}</span>`
    : `HTTP ${a.status_code}${a.response_body ? ` — <code>${esc(a.response_body.slice(0, 200))}</code>` : ''}`;
  return `<li class="${a.error || !ok ? 'err' : 'ok'}">
    <strong>Attempt ${a.attempt_no}</strong> <span class="muted">${esc(a.at)} UTC</span><br>${label}
  </li>`;
}

async function renderEvent(id) {
  const e = await api(`/api/events/${id}`);
  view.innerHTML = `
    <div class="row spread">
      <h1>Event #${e.id} <code>${esc(e.route_slug)}</code> ${badge(e.source)} ${badge(e.status)}</h1>
      <div class="row">
        <button id="replay">↻ Replay</button>
        <a class="btn" href="#/inbox">← Inbox</a>
      </div>
    </div>
    <p class="muted">Received ${esc(e.received_at)} UTC · ${e.attempt_count} delivery attempt(s)</p>
    <div class="grid2">
      <div class="panel"><h2 style="margin-top:0">Incoming payload</h2><pre>${esc(pretty(e.payload_json))}</pre>
        <h2>Headers</h2><pre>${esc(pretty(e.headers_json))}</pre></div>
      <div class="panel"><h2 style="margin-top:0">Transformed output</h2>
        ${e.transformed_json != null ? `<pre>${esc(pretty(e.transformed_json))}</pre>` : '<p class="muted">Not transformed yet.</p>'}
        <h2>Delivery timeline</h2>
        <ul class="timeline">
          <li class="ok"><strong>Received</strong> <span class="muted">${esc(e.received_at)} UTC · source: ${esc(e.source)}</span></li>
          ${e.attempts.map(attemptHtml).join('')}
          ${e.status === 'delivered' ? '<li class="ok"><strong>Delivered</strong></li>' : ''}
          ${e.status === 'dead' ? '<li class="err"><strong>Dead-lettered</strong> <span class="muted">retries exhausted or permanent error</span></li>' : ''}
          ${e.status === 'failed' ? '<li><strong>Retry scheduled</strong></li>' : ''}
        </ul></div>
    </div>`;
  document.getElementById('replay').onclick = async () => {
    const created = await api(`/api/events/${id}/replay`, { method: 'POST' });
    location.hash = `#/events/${created.id}`;
  };
}

// ── routes ───────────────────────────────────────────────────────────

async function renderRoutes() {
  const list = await api('/api/routes');
  view.innerHTML = `
    <div class="row spread"><h1>Routes</h1><a class="btn" href="#/routes/new">+ New route</a></div>
    ${list.length === 0 ? '<div class="panel"><p class="muted">No routes yet. A route gives you a catch URL, a transform, and a destination.</p></div>' : ''}
    ${list.map((r) => `
      <div class="panel">
        <div class="row spread">
          <div>
            <strong>${esc(r.name)}</strong> ${r.active ? '' : badge('dead')}
            <div class="muted">catch: <code>${esc(hookUrl(r.slug))}</code>
              <span class="copy" data-url="${esc(hookUrl(r.slug))}">📋</span></div>
            <div class="muted">→ ${r.destination_url ? `<code>${esc(r.destination_url)}</code>` : 'catch only (no destination)'}</div>
          </div>
          <div class="row">
            <a class="btn" href="#/routes/${r.id}/trigger">⚡ Trigger</a>
            <a class="btn" href="#/routes/${r.id}/edit">Edit</a>
            <button class="danger" data-del="${r.id}">Delete</button>
          </div>
        </div>
      </div>`).join('')}`;
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Delete this route and all its events?')) return;
      await api(`/api/routes/${b.dataset.del}`, { method: 'DELETE' });
      renderRoutes();
    };
  });
  view.querySelectorAll('.copy').forEach((c) => { c.onclick = () => copyText(c.dataset.url, c); });
}

const SAMPLE_BODY = '{\n  "user": { "name": "Ada", "email": "ada@example.com" },\n  "total": 4200\n}';

async function renderRouteForm(id) {
  const r = id ? await api(`/api/routes/${id}`) : {
    slug: '', name: '', signing_secret: '', transform_spec: 'body',
    destination_url: '', destination_headers: '{}', active: 1,
  };
  view.innerHTML = `
    <h1>${id ? `Edit route: ${esc(r.name)}` : 'New route'}</h1>
    <form id="route-form">
      <div class="grid2">
        <div class="panel">
          <label>Name</label><input name="name" value="${esc(r.name)}" required>
          <label>Slug <span class="muted">— catch URL becomes /hooks/&lt;slug&gt;</span></label>
          <input name="slug" value="${esc(r.slug)}" pattern="[a-z0-9][a-z0-9-]*" required>
          <label>Destination URL <span class="muted">— leave empty to catch only</span></label>
          <input name="destination_url" value="${esc(r.destination_url ?? '')}" placeholder="https://example.com/webhook">
          <label>Destination headers <span class="muted">(JSON object)</span></label>
          <textarea name="destination_headers" style="min-height:60px">${esc(r.destination_headers)}</textarea>
          <label>Signing secret <span class="muted">— optional HMAC-SHA256 check on incoming hooks</span></label>
          <input name="signing_secret" value="${esc(r.signing_secret ?? '')}">
          <label><input type="checkbox" name="active" style="width:auto" ${r.active ? 'checked' : ''}> Active</label>
        </div>
        <div class="panel">
          <label style="margin-top:0">Transform <span class="muted">(JSONata — input is {headers, body, route})</span></label>
          <textarea name="transform_spec" style="min-height:140px">${esc(r.transform_spec)}</textarea>
          <label>Sample incoming body <span class="muted">— for preview only</span></label>
          <textarea id="sample-body">${esc(SAMPLE_BODY)}</textarea>
          <div class="row" style="margin-top:10px"><button type="button" id="preview-btn">▶ Preview transform</button></div>
          <div id="preview-out"></div>
        </div>
      </div>
      <div class="row">
        <button type="submit" class="primary">${id ? 'Save changes' : 'Create route'}</button>
        <a class="btn" href="#/routes">Cancel</a>
        <span id="form-error" class="error-text"></span>
      </div>
    </form>`;

  const form = document.getElementById('route-form');
  document.getElementById('preview-btn').onclick = async () => {
    const out = document.getElementById('preview-out');
    let body;
    try { body = JSON.parse(document.getElementById('sample-body').value); }
    catch { out.innerHTML = '<p class="error-text">Sample body is not valid JSON</p>'; return; }
    const res = await api('/api/preview', { method: 'POST', body: { spec: form.transform_spec.value, body } });
    out.innerHTML = res.ok
      ? `<pre>${esc(JSON.stringify(res.result, null, 2))}</pre>`
      : `<p class="error-text">${esc(res.error)}</p>`;
  };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const payload = {
      name: form.name.value, slug: form.slug.value,
      signing_secret: form.signing_secret.value || null,
      transform_spec: form.transform_spec.value || 'body',
      destination_url: form.destination_url.value || null,
      destination_headers: form.destination_headers.value || '{}',
      active: form.active.checked,
    };
    try {
      await api(id ? `/api/routes/${id}` : '/api/routes', { method: id ? 'PUT' : 'POST', body: payload });
      location.hash = '#/routes';
    } catch (e) {
      document.getElementById('form-error').textContent = e.message;
    }
  };
}

// ── manual trigger ───────────────────────────────────────────────────

async function renderTrigger(id) {
  const [r, recent] = await Promise.all([
    api(`/api/routes/${id}`),
    api(`/api/events?route_id=${id}&limit=1`),
  ]);
  const prefill = recent.length ? pretty(recent[0].payload_json) : '{\n  "test": true\n}';
  view.innerHTML = `
    <h1>⚡ Trigger: ${esc(r.name)}</h1>
    <p class="muted">Fires the full pipeline — transform, delivery, retries — with a payload you provide.
      ${recent.length ? 'Pre-filled from the most recent caught event.' : ''}</p>
    <div class="panel">
      <label style="margin-top:0">Payload (JSON)</label>
      <textarea id="trigger-payload" style="min-height:220px">${esc(prefill)}</textarea>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="fire">⚡ Fire webhook</button>
        <a class="btn" href="#/routes">Cancel</a>
        <span id="trigger-error" class="error-text"></span>
      </div>
    </div>`;
  document.getElementById('fire').onclick = async () => {
    let payload;
    try { payload = JSON.parse(document.getElementById('trigger-payload').value); }
    catch { document.getElementById('trigger-error').textContent = 'Payload is not valid JSON'; return; }
    const event = await api(`/api/routes/${id}/trigger`, { method: 'POST', body: { payload } });
    location.hash = `#/events/${event.id}`;
  };
}

// ── status ───────────────────────────────────────────────────────────

async function renderStatus() {
  const s = await api('/api/status');
  view.innerHTML = `
    <h1>Status</h1>
    <div class="panel row spread">
      <div><span class="dot ${s.worker.healthy ? 'green' : 'red'}"></span>
        <strong> Delivery worker</strong> — ${s.worker.healthy ? 'running' : 'STALLED'}</div>
      <span class="muted">last tick: ${esc(s.worker.last_tick_at ?? 'never')}</span>
    </div>
    <div class="cards">
      ${s.routes.map((r) => `
        <div class="panel">
          <div class="row spread"><strong>${esc(r.name)}</strong><span class="dot ${r.health}"></span></div>
          <div class="muted"><code>/hooks/${esc(r.slug)}</code>${r.active ? '' : ' · inactive'}</div>
          <div class="row" style="margin-top:10px; gap:20px">
            <div><div class="stat">${r.received_24h}</div><div class="muted">received 24h</div></div>
            <div><div class="stat">${r.delivered_24h}</div><div class="muted">delivered 24h</div></div>
            <div><div class="stat">${r.pending}</div><div class="muted">pending</div></div>
            <div><div class="stat" style="${r.dead_total ? 'color:var(--red)' : ''}">${r.dead_total}</div><div class="muted">dead</div></div>
          </div>
          <div class="muted" style="margin-top:8px">
            success rate 24h: ${r.success_rate_24h == null ? '—' : Math.round(r.success_rate_24h * 100) + '%'}
            · last received: ${esc(r.last_received_at ?? 'never')}
          </div>
        </div>`).join('')}
    </div>
    ${s.routes.length === 0 ? '<div class="panel"><p class="muted">No routes configured yet.</p></div>' : ''}`;
}

navigate();
