'use strict';

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------
const WORKFLOW_FILE = 'generate.yml';
const FALLBACK_REPO = { owner: 'FrajerFilip', repo: 'content_management_J5M' };
const LABELS = ['Hook', 'Info 1', 'Info 2', 'Výzva k akci'];
const TYPES = ['hook', 'info', 'info', 'cta'];
const STORAGE = { draft: 'reels.draft.v3', conn: 'reels.conn', token: 'reels.token', options: 'reels.options' };
const DEFAULT_OPTIONS = { voice: 'auto', speed: 1, music: true, captions: true };

let PRESETS = null; // načte se z presets.json
let slides = [];

const $ = (id) => document.getElementById(id);

// localStorage může být zablokovaný (soukromé okno apod.)
const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, val) { try { localStorage.setItem(key, val); } catch { /* ignore */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function richHtml(text) {
  return escapeHtml(text).replace(/&lt;(\/?)(strong|em|s|br)\s*\/?&gt;/gi, '<$1$2>');
}
const plain = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const fmt = (n) => n.toFixed(1).replace('.', ',');

function loadDraft() {
  try {
    const d = JSON.parse(store.get(STORAGE.draft));
    if (Array.isArray(d) && d.length === 4) return d;
  } catch { /* ignore */ }
  return structuredClone(PRESETS.scenarios[0].slides);
}

const typedSlides = () => slides.map((s, i) => ({ ...s, type: TYPES[i] }));

// ---------------------------------------------------------------------------
// Nastavení videa (hlas, tempo, hudba, titulky)
// ---------------------------------------------------------------------------
function loadOptions() {
  let o = { ...DEFAULT_OPTIONS };
  try { o = { ...o, ...JSON.parse(store.get(STORAGE.options)) }; } catch { /* ignore */ }
  $('optVoice').value = o.voice;
  $('optSpeed').value = String(o.speed);
  $('optMusic').checked = !!o.music;
  $('optCaptions').checked = !!o.captions;
}

function options() {
  return {
    voice: $('optVoice').value,
    speed: Number($('optSpeed').value) || 1,
    music: $('optMusic').checked,
    captions: $('optCaptions').checked,
  };
}

// ---------------------------------------------------------------------------
// Animovaný náhled – stejná šablona jako při renderu (template.html v iframe)
// ---------------------------------------------------------------------------
let R = null;
let previewTimer = null;
let spokenScene = -1;

function initPlayer() {
  const iframe = $('player');
  const ready = () => {
    R = iframe.contentWindow && iframe.contentWindow.R;
    if (!R) return;
    R.onTime(onPlayerTime);
    refreshPreview();
  };
  if (iframe.contentWindow && iframe.contentWindow.R) ready();
  else iframe.addEventListener('load', ready, { once: true });

  // zmenšení plátna 1080×1920 na šířku panelu
  const fit = () => { iframe.style.transform = `scale(${$('stage').clientWidth / 1080})`; };
  new ResizeObserver(fit).observe($('stage'));
  fit();
}

async function refreshPreview() {
  if (!R) return;
  const wasPlaying = R.isPlaying();
  const t = Number($('scrub').value) || 0;
  const tl = R.estimateTimeline(typedSlides(), options());
  await R.setup({ ...tl, captions: options().captions, debug: $('safeZones').checked });
  $('scrub').max = tl.duration.toFixed(2);
  updateEstimates(tl);
  if (wasPlaying) R.play(Math.min(t, tl.duration));
  else { R.seek(Math.min(t, tl.duration)); onPlayerTime(Math.min(t, tl.duration), false); }
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 300);
}

function updateEstimates(tl) {
  const over = tl.duration > 20.05 || tl.tempo > 1.12;
  $('estimate').innerHTML = `Odhadovaná délka videa <strong>${fmt(tl.duration)} s</strong>` +
    (tl.tempo > 1.001 ? ` · voiceover se zrychlí ×${tl.tempo.toFixed(2).replace('.', ',')}` : '') +
    (over ? ' – zkus voiceover zkrátit' : '');
  $('estimate').classList.toggle('warn', over);
  document.querySelectorAll('#slides .slide').forEach((card, i) => {
    const sc = tl.scenes[i];
    card.querySelector('.vo-est').textContent = `≈ ${fmt(sc.voiceDuration)} s řeči · scéna ${fmt(sc.duration)} s`;
  });
}

function onPlayerTime(t, playing) {
  $('scrub').value = String(t);
  $('timeLabel').textContent = `${fmt(t)} / ${fmt(R ? R.duration : 0)} s`;
  $('playBtn').textContent = playing ? '❚❚' : '▶';
  $('playBtn').setAttribute('aria-label', playing ? 'Pozastavit' : 'Přehrát');

  // orientační předčítání hlasem prohlížeče
  if (!playing) { spokenScene = -1; return; }
  if (!$('browserVoice').checked || !('speechSynthesis' in window)) return;
  const tl = R.estimateTimeline(typedSlides(), options());
  const i = tl.scenes.findIndex((s) => t >= s.voiceStart && t < s.voiceStart + 0.5);
  if (i !== -1 && i !== spokenScene) {
    spokenScene = i;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(R.voiceText(tl.scenes[i]));
    u.lang = 'cs-CZ';
    u.rate = options().speed * tl.tempo;
    const cs = speechSynthesis.getVoices().find((v) => v.lang && v.lang.toLowerCase().startsWith('cs'));
    if (cs) u.voice = cs;
    speechSynthesis.speak(u);
  }
}

function togglePlay() {
  if (!R) return;
  if (R.isPlaying()) {
    R.pause();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  } else {
    spokenScene = -1;
    R.play(Number($('scrub').value) || 0);
  }
}

function playScene(i) {
  if (!R) return;
  const tl = R.estimateTimeline(typedSlides(), options());
  spokenScene = -1;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  R.play(tl.scenes[i].start);
  $('player').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------------------------------------------------------------------
// Editor snímků
// ---------------------------------------------------------------------------
function buildEditor() {
  const container = $('slides');
  container.innerHTML = '';
  const tpl = $('slideTpl');

  slides.forEach((slide, i) => {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.querySelector('.slide-title').innerHTML = `<span class="badge">${i + 1}</span> ${LABELS[i]}`;
    node.querySelector('.play-scene').addEventListener('click', () => playScene(i));

    node.querySelectorAll('[data-field]').forEach((input) => {
      const field = input.dataset.field;
      input.value = slide[field] || '';
      if (field === 'voiceover') input.placeholder = `${plain(slide.heading)}. ${plain(slide.mainText)}`;
      input.addEventListener('input', () => {
        slides[i][field] = input.value;
        store.set(STORAGE.draft, JSON.stringify(slides));
        $('scenario').value = '';
        schedulePreview();
      });
    });

    container.appendChild(node);
  });
  schedulePreview();
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
  let c = detectRepo();
  try {
    const saved = JSON.parse(store.get(STORAGE.conn));
    if (saved?.owner && saved?.repo) c = saved;
  } catch { /* ignore */ }
  $('owner').value = c.owner;
  $('repo').value = c.repo;
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

async function gh(path, opts = {}) {
  const { token } = conn();
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
    const hints = {
      401: 'Token je neplatný nebo vypršel.',
      403: 'Token nemá oprávnění „Actions: Read and write“ pro tento repozitář.',
      404: 'Repozitář nebo workflow nenalezen – zkontroluj vlastníka, název repozitáře a přístup tokenu.',
      422: 'GitHub odmítl požadavek – workflow na výchozí větvi možná ještě nemá vstupy „slides“, „options“ a „request_id“.',
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
    const payload = slides.map((s) => ({
      tag: (s.tag || '').trim(),
      heading: (s.heading || '').trim(),
      mainText: (s.mainText || '').trim(),
      voiceover: (s.voiceover || '').trim(),
      imageUrl: (s.imageUrl || '').trim(),
    }));

    await gh(`${base}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      body: JSON.stringify({
        ref: repoInfo.default_branch,
        inputs: { slides: JSON.stringify(payload), options: JSON.stringify(options()), request_id: requestId },
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
  'Nastavení Pythonu (hlas Piper)': 'Připravuji hlas…',
  'Instalace Piper TTS': 'Připravuji hlas…',
  'Mezipaměť hlasového modelu': 'Připravuji hlas…',
  'Stažení českého hlasu': 'Připravuji hlas…',
  'Spuštění generátoru': 'Namlouvám voiceover, renderuji animaci a míchám zvuk…',
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
const VOICE_NAMES = { piper: 'Piper', elevenlabs: 'ElevenLabs', openai: 'OpenAI', none: 'bez hlasu' };

async function loadLatest(expectedRequestId) {
  try {
    const res = await fetch(`latest.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const meta = await res.json();
    if (expectedRequestId && meta.requestId !== expectedRequestId) return false;

    const v = encodeURIComponent(meta.requestId || meta.generatedAt);
    const src = `videos/reels-output.mp4?v=${v}`;
    $('video').src = src;
    $('video').poster = `videos/cover.jpg?v=${v}`;
    $('downloadLink').href = src;
    $('coverLink').href = `videos/cover.jpg?v=${v}`;
    $('srtLink').href = `videos/captions.srt?v=${v}`;
    $('downloads').hidden = false;
    $('noVideo').hidden = true;

    const when = new Date(meta.generatedAt).toLocaleString('cs-CZ');
    const voice = meta.voice ? ` · hlas: ${VOICE_NAMES[meta.voice] || meta.voice}` : '';
    $('videoMeta').textContent = `${meta.width}×${meta.height} · ${fmt(Number(meta.duration))} s${voice} · ${when}`;
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
    PRESETS.scenarios.map((sc) => `<option value="${escapeHtml(sc.id)}">${escapeHtml(sc.name)}</option>`).join('');
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
  $('productClaim').innerHTML = richHtml(p.claim);
  $('productSubtitle').textContent = p.subtitle;
  $('productAudience').textContent = p.audience;
  $('productFacts').innerHTML = p.facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
  $('productChapters').innerHTML = p.chapters
    .map((c, i) => `<li><span>${String(i + 1).padStart(2, '0')}</span>${escapeHtml(c)}</li>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
async function init() {
  loadConnection();
  loadOptions();

  $('settingsBtn').addEventListener('click', () => openSettings($('settings').hidden));
  ['owner', 'repo', 'token', 'remember'].forEach((id) => $(id).addEventListener('change', saveConnection));
  ['optVoice', 'optSpeed', 'optMusic', 'optCaptions'].forEach((id) => $(id).addEventListener('change', () => {
    store.set(STORAGE.options, JSON.stringify(options()));
    schedulePreview();
  }));
  $('safeZones').addEventListener('change', refreshPreview);
  $('playBtn').addEventListener('click', togglePlay);
  $('scrub').addEventListener('input', () => {
    if (!R) return;
    if (R.isPlaying()) R.pause();
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    R.seek(Number($('scrub').value));
    onPlayerTime(Number($('scrub').value), false);
  });
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
    PRESETS = await (await fetch('presets.json')).json();
  } catch {
    PRESETS = { product: null, scenarios: [{ id: 'empty', name: 'Prázdný', slides: TYPES.map(() => ({ tag: '', heading: '', mainText: '', voiceover: '', imageUrl: '' })) }] };
  }
  renderProduct();
  renderScenarios();
  slides = loadDraft();
  buildEditor();
  initPlayer();
  loadLatest();
}

init();
