'use strict';

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------
const WORKFLOW_FILE = 'generate.yml';
const FALLBACK_REPO = { owner: 'FrajerFilip', repo: 'content_management_J5M' };
const LABELS = ['Hook', 'Info 1', 'Info 2', 'Výzva k akci'];
const TYPES = ['hook', 'info', 'info', 'cta'];
const STORAGE = { draft: 'reels.draft.v2', conn: 'reels.conn', token: 'reels.token' };

let PRESETS = null; // načte se z presets.json
const defaultSlides = () => structuredClone(PRESETS.scenarios[0].slides);

const $ = (id) => document.getElementById(id);

// localStorage může být zablokovaný (soukromé okno apod.)
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, val) { try { localStorage.setItem(key, val); } catch { /* ignore */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------------------
// Šablona – stejná logika dosazení jako v index.js
// ---------------------------------------------------------------------------
let template = '';
let slides = [];

function sanitize(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/&lt;(\/?)(strong|em|s|br)\s*\/?&gt;/gi, '<$1$2>')
    .replace(/\n/g, '<br>')
    // česká typografie: jednopísmenné předložky/spojky nezůstanou na konci řádku
    .replace(/(^|[\s>(„])([kvszouaiKVSZOUAI]) +/g, '$1$2\u00A0')
    .replace(/(^|[\s>(„])([kvszouaiKVSZOUAI]) +/g, '$1$2\u00A0');
}

function renderTemplate(slide, i, debug) {
  const url = /^https?:\/\//i.test(slide.imageUrl || '') ? slide.imageUrl : '';
  let html = template
    .replace(/{{HEADING}}/g, sanitize(slide.heading))
    .replace(/{{MAIN_TEXT}}/g, sanitize(slide.mainText))
    .replace(/{{IMAGE_URL}}/g, url.replace(/&/g, '&amp;').replace(/"/g, '&quot;'))
    .replace(/{{TAG}}/g, sanitize(slide.tag))
    .replace(/{{TYPE}}/g, TYPES[i] + (debug ? ' debug' : ''));
  return html;
}

function loadDraft() {
  try {
    const d = JSON.parse(store.get(STORAGE.draft));
    if (Array.isArray(d) && d.length === 4) return d;
  } catch { /* ignore */ }
  return defaultSlides();
}

// ---------------------------------------------------------------------------
// Editor snímků
// ---------------------------------------------------------------------------
const previewTimers = [];

function buildEditor() {
  const container = $('slides');
  container.innerHTML = '';
  const tpl = $('slideTpl');

  slides.forEach((slide, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.slide-title').innerHTML =
      `<span class="badge">${i + 1}</span> ${LABELS[i]}`;

    node.querySelectorAll('[data-field]').forEach((input) => {
      const field = input.dataset.field;
      input.value = slide[field] || '';
      input.addEventListener('input', () => {
        slides[i][field] = input.value;
        store.set(STORAGE.draft, JSON.stringify(slides));
        $('scenario').value = '';
        schedulePreview(i);
      });
    });

    container.appendChild(node);
  });

  slides.forEach((_, i) => updatePreview(i));
}

function updatePreview(i) {
  if (!template) return;
  const iframe = $('slides').children[i]?.querySelector('iframe');
  if (iframe) iframe.srcdoc = renderTemplate(slides[i], i, $('safeZones').checked);
}

function schedulePreview(i) {
  clearTimeout(previewTimers[i]);
  previewTimers[i] = setTimeout(() => updatePreview(i), 250);
}

// ---------------------------------------------------------------------------
// Připojení ke GitHubu
// ---------------------------------------------------------------------------
function detectRepo() {
  const { hostname, pathname } = location;
  if (hostname.endsWith('.github.io')) {
    const owner = hostname.split('.')[0];
    const repo = pathname.split('/').filter(Boolean)[0];
    if (repo) return { owner, repo };
  }
  return FALLBACK_REPO;
}

function loadConnection() {
  let conn = detectRepo();
  try {
    const saved = JSON.parse(store.get(STORAGE.conn));
    if (saved?.owner && saved?.repo) conn = saved;
  } catch { /* ignore */ }
  $('owner').value = conn.owner;
  $('repo').value = conn.repo;
  const token = store.get(STORAGE.token);
  if (token) {
    $('token').value = token;
    $('remember').checked = true;
  }
}

function saveConnection() {
  store.set(STORAGE.conn, JSON.stringify({ owner: $('owner').value.trim(), repo: $('repo').value.trim() }));
  if ($('remember').checked && $('token').value.trim()) store.set(STORAGE.token, $('token').value.trim());
  else store.del(STORAGE.token);
}

function conn() {
  return { owner: $('owner').value.trim(), repo: $('repo').value.trim(), token: $('token').value.trim() };
}

async function gh(path, options = {}) {
  const { token } = conn();
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
    const hints = {
      401: 'Token je neplatný nebo vypršel.',
      403: 'Token nemá oprávnění „Actions: Read and write“ pro tento repozitář.',
      404: 'Repozitář nebo workflow nenalezen – zkontroluj vlastníka, název repozitáře a přístup tokenu.',
      422: 'GitHub odmítl požadavek – workflow na výchozí větvi možná nemá vstupy „slides“ a „request_id“.',
    };
    throw new Error(`${hints[res.status] || 'Chyba GitHub API.'} (${res.status}: ${msg})`);
  }
  return res.status === 204 ? null : res.json();
}

function openSettings(open = true) {
  $('settings').hidden = !open;
  $('settingsBtn').setAttribute('aria-expanded', String(open));
  if (open) $('token').focus();
}

// ---------------------------------------------------------------------------
// Generování
// ---------------------------------------------------------------------------
let timer = null;

function setStatus(text, state = 'busy', runUrl) {
  const box = $('status');
  box.hidden = false;
  box.className = `status ${state === 'busy' ? '' : state}`;
  $('statusText').textContent = text;
  if (runUrl) {
    $('runLink').href = runUrl;
    $('runLink').hidden = false;
  }
  if (state !== 'busy') stopTimer();
}

function startTimer() {
  const started = Date.now();
  stopTimer();
  const tick = () => {
    const s = Math.floor((Date.now() - started) / 1000);
    $('statusTime').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  tick();
  timer = setInterval(tick, 1000);
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function validate() {
  for (let i = 0; i < slides.length; i++) {
    if (!slides[i].heading?.trim()) return `Snímek ${i + 1} (${LABELS[i]}) nemá nadpis.`;
  }
  return null;
}

async function generate() {
  const { owner, repo, token } = conn();
  if (!token || !owner || !repo) {
    openSettings(true);
    setStatus('Nejdřív vyplň připojení ke GitHubu (token).', 'err');
    return;
  }
  const invalid = validate();
  if (invalid) {
    setStatus(invalid, 'err');
    return;
  }
  saveConnection();

  const btn = $('generateBtn');
  btn.disabled = true;
  $('runLink').hidden = true;
  startTimer();

  const requestId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  try {
    setStatus('Spouštím workflow…');
    const repoInfo = await gh(base);
    const payload = slides.map(({ tag, heading, mainText, imageUrl }) => ({
      tag: (tag || '').trim(),
      heading: heading.trim(),
      mainText: (mainText || '').trim(),
      imageUrl: (imageUrl || '').trim(),
    }));

    await gh(`${base}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({
        ref: repoInfo.default_branch,
        inputs: { slides: JSON.stringify(payload), request_id: requestId },
      }),
    });

    // Najdi běh podle request_id v názvu (run-name)
    setStatus('Čekám, až GitHub běh zařadí…');
    let run = null;
    for (let i = 0; i < 40 && !run; i++) {
      await sleep(3000);
      const data = await gh(`${base}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=20`);
      run = data.workflow_runs.find((r) => (r.display_title || '').includes(requestId));
    }
    if (!run) throw new Error('Běh se nepodařilo najít. Zkontroluj záložku Actions v repozitáři.');

    // Sleduj průběh
    while (run.status !== 'completed') {
      const step = await currentStep(base, run.id);
      setStatus(run.status === 'queued' ? 'Ve frontě…' : step || 'Probíhá…', 'busy', run.html_url);
      await sleep(5000);
      run = await gh(`${base}/actions/runs/${run.id}`);
    }

    if (run.conclusion !== 'success') {
      throw Object.assign(new Error(`Běh skončil stavem „${run.conclusion}“. Podrobnosti najdeš v logu.`), { runUrl: run.html_url });
    }

    // Počkej, až GitHub Pages servíruje nové video
    setStatus('Načítám nové video…', 'busy', run.html_url);
    let ok = false;
    for (let i = 0; i < 36 && !ok; i++) {
      ok = await loadLatest(requestId);
      if (!ok) await sleep(5000);
    }
    if (ok) setStatus('Hotovo! Video je připravené níže.', 'ok', run.html_url);
    else setStatus('Video je hotové – web se ještě aktualizuje. Obnov stránku za minutu, nebo si ho stáhni z běhu (Artifacts).', 'ok', run.html_url);
  } catch (err) {
    setStatus(err.message, 'err', err.runUrl);
  } finally {
    btn.disabled = false;
    stopTimer();
  }
}

const STEP_LABELS = {
  'Instalace FFmpeg a fontů': 'Instaluji FFmpeg…',
  'Instalace NPM závislostí': 'Instaluji závislosti…',
  'Spuštění generátoru': 'Renderuji snímky a skládám video…',
  'Nahrání videa jako artefaktu': 'Ukládám video…',
  'Sestavení webu (aplikace + poslední video)': 'Připravuji web…',
  'Nahrání webu pro GitHub Pages': 'Připravuji web…',
  'Nasazení na GitHub Pages': 'Publikuji video na web…',
};

async function currentStep(base, runId) {
  try {
    const { jobs } = await gh(`${base}/actions/runs/${runId}/jobs`);
    for (const job of jobs) {
      const step = (job.steps || []).find((s) => s.status === 'in_progress');
      if (step) return STEP_LABELS[step.name] || `${step.name}…`;
    }
    if (jobs.some((j) => j.name === 'deploy' && j.status !== 'completed')) return 'Publikuji video na web…';
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Přehrávač posledního videa
// ---------------------------------------------------------------------------
async function loadLatest(expectedRequestId) {
  try {
    const res = await fetch(`latest.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const meta = await res.json();
    if (expectedRequestId && meta.requestId !== expectedRequestId) return false;

    const v = $('video');
    const src = `videos/reels-output.mp4?v=${encodeURIComponent(meta.requestId || meta.generatedAt)}`;
    v.src = src;
    $('downloadLink').href = src;
    $('downloadLink').hidden = false;
    $('noVideo').hidden = true;

    const when = new Date(meta.generatedAt).toLocaleString('cs-CZ');
    $('videoMeta').textContent =
      `${meta.width}×${meta.height} · ${Number(meta.duration).toFixed(1)} s · vygenerováno ${when}`;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Scénáře a informace o produktu
// ---------------------------------------------------------------------------
function renderScenarios() {
  const sel = $('scenario');
  sel.innerHTML = '<option value="">— vlastní úpravy —</option>' +
    PRESETS.scenarios.map((sc) => `<option value="${sc.id}">${sanitize(sc.name)}</option>`).join('');
  sel.value = store.get(STORAGE.draft) ? '' : PRESETS.scenarios[0].id;
}

function loadScenario(id) {
  const sc = PRESETS.scenarios.find((x) => x.id === id);
  if (!sc) return;
  slides = structuredClone(sc.slides);
  store.del(STORAGE.draft);
  $('scenario').value = id;
  buildEditor();
}

function renderProduct() {
  const p = PRESETS.product;
  if (!p) return;
  $('productName').textContent = p.name;
  $('productClaim').innerHTML = sanitize(p.claim);
  $('productSubtitle').textContent = p.subtitle;
  $('productAudience').textContent = p.audience;
  $('productFacts').innerHTML = p.facts.map((f) => `<li>${sanitize(f)}</li>`).join('');
  $('productChapters').innerHTML = p.chapters
    .map((c, i) => `<li><span>${String(i + 1).padStart(2, '0')}</span>${sanitize(c)}</li>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function init() {
  loadConnection();

  $('settingsBtn').addEventListener('click', () => openSettings($('settings').hidden));
  ['owner', 'repo', 'token', 'remember'].forEach((id) => $(id).addEventListener('change', saveConnection));
  $('safeZones').addEventListener('change', () => slides.forEach((_, i) => updatePreview(i)));
  $('scenario').addEventListener('change', () => loadScenario($('scenario').value));
  $('resetBtn').addEventListener('click', () => loadScenario($('scenario').value || PRESETS.scenarios[0].id));
  $('generateBtn').addEventListener('click', generate);
  $('testBtn').addEventListener('click', async () => {
    const out = $('testResult');
    out.textContent = 'Ověřuji…';
    out.style.color = '';
    try {
      saveConnection();
      const { owner, repo } = conn();
      await gh(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${WORKFLOW_FILE}`);
      out.textContent = '✓ Připojeno, workflow nalezen.';
      out.style.color = 'var(--ok)';
    } catch (err) {
      out.textContent = err.message;
      out.style.color = 'var(--err)';
    }
  });

  if (!conn().token) openSettings(true);

  try {
    const [tplRes, presetRes] = await Promise.all([fetch('template.html'), fetch('presets.json')]);
    template = await tplRes.text();
    PRESETS = await presetRes.json();
  } catch {
    template = '<body style="background:#15213d;color:#fff;font:40px sans-serif;padding:60px">Šablona se nenačetla</body>';
    PRESETS = { product: null, scenarios: [{ id: 'empty', name: 'Prázdný', slides: TYPES.map(() => ({ tag: '', heading: '', mainText: '', imageUrl: '' })) }] };
  }
  renderProduct();
  renderScenarios();
  slides = loadDraft();
  buildEditor();
  loadLatest();
}

init();
