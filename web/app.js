'use strict';

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------
const WORKFLOW_FILE = 'generate.yml';
const FALLBACK_REPO = { owner: 'FrajerFilip', repo: 'content_management_J5M' };
const LABELS = ['Hook', 'Info 1', 'Info 2', 'Výzva k akci'];
const STORAGE = { draft: 'reels.draft', conn: 'reels.conn', token: 'reels.token' };

const DEFAULT_SLIDES = [
  {
    heading: 'Pijete málo vody? 💧',
    mainText: 'Už <strong>2 % dehydratace</strong> sníží vaši koncentraci. Tohle musíte vědět!',
    imageUrl: 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=1080&h=1920&fit=crop&q=80',
  },
  {
    heading: 'Mozek je ze 75 % voda',
    mainText: 'Při nedostatku tekutin se zpomaluje reakční doba a roste únava. Mozek to pozná <strong>dřív než žízeň</strong>.',
    imageUrl: 'https://images.unsplash.com/photo-1559757175-5700dde675bc?w=1080&h=1920&fit=crop&q=80',
  },
  {
    heading: 'Kolik vody denně?',
    mainText: 'Orientačně <strong>30–35 ml na 1 kg</strong> tělesné váhy. Při sportu a v horku ještě víc.',
    imageUrl: 'https://images.unsplash.com/photo-1523362628745-0c100150b504?w=1080&h=1920&fit=crop&q=80',
  },
  {
    heading: 'Sleduj pro další tipy! 🚀',
    mainText: 'Ulož si video, ať nezapomeneš, a <strong>pošli ho kamarádovi</strong>, který pořád zapomíná pít.',
    imageUrl: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=1080&h=1920&fit=crop&q=80',
  },
];

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
let slides = loadDraft();

function sanitize(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/&lt;(\/?)(strong|em|br)\s*\/?&gt;/gi, '<$1$2>')
    .replace(/\n/g, '<br>');
}

function renderTemplate(slide, debug) {
  const url = /^https?:\/\//i.test(slide.imageUrl || '') ? slide.imageUrl : '';
  let html = template
    .replace(/{{HEADING}}/g, sanitize(slide.heading))
    .replace(/{{MAIN_TEXT}}/g, sanitize(slide.mainText))
    .replace(/{{IMAGE_URL}}/g, url.replace(/&/g, '&amp;').replace(/"/g, '&quot;'));
  if (debug) {
    const i = html.lastIndexOf('<body>'); // poslední výskyt = skutečná značka (ne komentář v CSS)
    if (i !== -1) html = `${html.slice(0, i)}<body class="debug">${html.slice(i + 6)}`;
  }
  return html;
}

function loadDraft() {
  try {
    const d = JSON.parse(store.get(STORAGE.draft));
    if (Array.isArray(d) && d.length === 4) return d;
  } catch { /* ignore */ }
  return structuredClone(DEFAULT_SLIDES);
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
  if (iframe) iframe.srcdoc = renderTemplate(slides[i], $('safeZones').checked);
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
    const payload = slides.map(({ heading, mainText, imageUrl }) => ({
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
// Start
// ---------------------------------------------------------------------------
async function init() {
  loadConnection();

  $('settingsBtn').addEventListener('click', () => openSettings($('settings').hidden));
  ['owner', 'repo', 'token', 'remember'].forEach((id) => $(id).addEventListener('change', saveConnection));
  $('safeZones').addEventListener('change', () => slides.forEach((_, i) => updatePreview(i)));
  $('resetBtn').addEventListener('click', () => {
    slides = structuredClone(DEFAULT_SLIDES);
    store.del(STORAGE.draft);
    buildEditor();
  });
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
    template = await (await fetch('template.html')).text();
  } catch {
    template = '<body style="background:#222;color:#fff;font:40px sans-serif;padding:60px">Šablona se nenačetla</body>';
  }
  buildEditor();
  loadLatest();
}

init();
