'use strict';

/**
 * Generátor animovaných Reels / TikTok videí s voiceoverem (15–20 s, 1080x1920, 30 FPS).
 *
 * 1) Načte 4 snímky (hook, info, info, výzva k akci) a nastavení
 * 2) Namluví voiceover každého snímku (Piper / ElevenLabs / OpenAI)
 * 3) Podle délky hlasu spočítá časování scén
 * 4) Puppeteer vyrenderuje animaci z template.html snímek po snímku (30 FPS)
 * 5) FFmpeg vytvoří zvukovou stopu (hlas + hudba + efekty) a spojí vše do MP4
 *
 * Výstup v output/: reels-output.mp4, cover.jpg, captions.srt, latest.json
 */

const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { synthesizeAll } = require('./lib/tts');
const { buildAudio } = require('./lib/audio');
const { openTemplate, buildTimeline, renderVideo } = require('./lib/render');

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------
const FPS = 30;
const ROOT = __dirname;
const TEMPLATE_PATH = path.join(ROOT, 'template.html');
const TEMP_DIR = path.join(ROOT, 'temp');
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'reels-output.mp4');

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);

const PRESETS = JSON.parse(fs.readFileSync(path.join(ROOT, 'presets.json'), 'utf8'));
const SLIDE_TYPES = ['hook', 'info', 'info', 'cta'];
const LIMITS = { heading: 120, mainText: 400, tag: 60, voiceover: 300 };

// ---------------------------------------------------------------------------
// Vstupy
//   SLIDES_JSON  = JSON pole 4 snímků [{tag, heading, mainText, voiceover, imageUrl}]
//   OPTIONS_JSON = {"voice": "auto|elevenlabs|azure|openai|piper|none", "gender": "male|female",
//                   "speed": 1, "music": true, "captions": true}
// ---------------------------------------------------------------------------
function parseJsonEnv(name) {
  const raw = (process.env[name] || '').trim();
  if (!raw || raw === 'null' || raw === '""') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${name} není platný JSON: ${err.message}`);
  }
}

function loadSlides() {
  let data = parseJsonEnv('SLIDES_JSON');
  if (!data) {
    console.log(`ℹ️  SLIDES_JSON není zadán – používám scénář „${PRESETS.scenarios[0].name}“.`);
    data = PRESETS.scenarios[0].slides;
  }
  if (!Array.isArray(data) || data.length !== SLIDE_TYPES.length) {
    throw new Error(`SLIDES_JSON musí být pole s přesně ${SLIDE_TYPES.length} snímky.`);
  }

  return data.map((s, i) => {
    const out = { type: SLIDE_TYPES[i] };
    for (const key of Object.keys(LIMITS)) {
      out[key] = String(s?.[key] ?? '').trim();
      if (out[key].length > LIMITS[key]) throw new Error(`Snímek ${i + 1}: pole „${key}“ je delší než ${LIMITS[key]} znaků.`);
    }
    if (!out.heading) throw new Error(`Snímek ${i + 1}: chybí nadpis.`);
    const imageUrl = String(s?.imageUrl ?? '').trim();
    out.imageUrl = /^https?:\/\//i.test(imageUrl) ? imageUrl : '';
    return out;
  });
}

function loadOptions() {
  const o = parseJsonEnv('OPTIONS_JSON') || {};
  const speed = Number(o.speed ?? 1);
  return {
    voice: String(o.voice || process.env.TTS_PROVIDER || 'auto'),
    gender: o.gender === 'female' ? 'female' : 'male',
    speed: Number.isFinite(speed) ? Math.min(1.3, Math.max(0.8, speed)) : 1,
    music: o.music !== false,
    captions: o.captions !== false,
  };
}

// Text pro TTS: bez HTML značek; prázdný voiceover = nadpis + text snímku
const plain = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const voiceText = (s) => plain(s.voiceover) || `${plain(s.heading)}. ${plain(s.mainText)}`;

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------
function prepareDir(dir, clean = false) {
  if (clean && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function mux(video, audio, out) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(video)
      .input(audio)
      .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a copy', '-shortest', '-movflags +faststart'])
      .output(out)
      .on('error', (err, _o, stderr) => reject(new Error(`${err.message}\n${(stderr || '').slice(-1500)}`)))
      .on('end', resolve)
      .run();
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

function srtTime(t) {
  const ms = Math.round(t * 1000);
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

// Titulky jako .srt (hodí se pro ruční nahrání na sociální sítě)
function writeSrt(scenes, file) {
  const cues = [];
  scenes.forEach((sc) => {
    let cur = [];
    sc.words.forEach((w, k) => {
      cur.push(w);
      if (/[.!?…,;:–]$/.test(w.w) || cur.length >= 6 || k === sc.words.length - 1) {
        cues.push({ s: cur[0].s, e: Math.min(cur[cur.length - 1].e + 0.3, sc.start + sc.duration), text: cur.map((x) => x.w).join(' ') });
        cur = [];
      }
    });
  });
  const body = cues.map((c, i) => `${i + 1}\n${srtTime(c.s)} --> ${srtTime(c.e)}\n${c.text}\n`).join('\n');
  fs.writeFileSync(file, body);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const started = Date.now();
  let browser;
  try {
    const slides = loadSlides();
    const options = loadOptions();
    prepareDir(TEMP_DIR, true);
    prepareDir(OUTPUT_DIR);
    console.log(`⚙️  Nastavení: hlas=${options.voice} (${options.gender === 'female' ? 'ženský' : 'mužský'}), rychlost=${options.speed}, hudba=${options.music}, titulky=${options.captions}`);

    // 1) voiceover
    const { provider, voices } = await synthesizeAll(slides.map(voiceText), TEMP_DIR, { provider: options.voice, speed: options.speed, gender: options.gender });

    // 2) časování + animace
    let page;
    ({ browser, page } = await openTemplate(TEMPLATE_PATH));
    const timeline = await buildTimeline(page, slides, voices.map((v) => ({ duration: v.duration, words: v.words })));
    console.log(`⏱️  Délka videa ${timeline.duration.toFixed(2)} s, scény: ${timeline.scenes.map((s) => s.duration.toFixed(2)).join(' + ')} s` +
      (timeline.tempo !== 1 ? `, voiceover zrychlen ×${timeline.tempo.toFixed(2)}` : ''));
    if (timeline.duration > 20.05) console.warn('⚠️  Video je delší než 20 s – zkraťte texty voiceoveru.');

    const videoOnly = path.join(TEMP_DIR, 'video.mp4');
    const coverFile = path.join(OUTPUT_DIR, 'cover.jpg');
    const data = { ...timeline, captions: options.captions };
    await renderVideo(page, data, { fps: FPS, out: videoOnly, coverFile, coverTime: timeline.scenes[0].start + Math.min(2.2, timeline.scenes[0].duration - 0.4) });
    await browser.close();
    browser = null;

    // 3) zvuk
    console.log(`🎵 Míchám zvuk (hlas${options.music ? ' + hudba + efekty' : ''})…`);
    const audio = path.join(TEMP_DIR, 'audio.m4a');
    await buildAudio({ voices, scenes: timeline.scenes, duration: timeline.duration, tempo: timeline.tempo, music: options.music, musicGain: provider === 'none' ? 2.5 : 1, out: audio });

    // 4) finální MP4
    await mux(videoOnly, audio, OUTPUT_FILE);
    writeSrt(timeline.scenes, path.join(OUTPUT_DIR, 'captions.srt'));

    const info = await probe(OUTPUT_FILE);
    const v = info.streams.find((s) => s.codec_type === 'video');
    const a = info.streams.find((s) => s.codec_type === 'audio');

    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
    const meta = {
      requestId: process.env.REQUEST_ID || null,
      generatedAt: new Date().toISOString(),
      runUrl: GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : null,
      duration: Number(info.format.duration),
      width: v.width,
      height: v.height,
      voice: provider,
      options,
      slides,
      timeline: timeline.scenes.map(({ start, duration, voiceStart }) => ({ start, duration, voiceStart })),
    };
    fs.writeFileSync(path.join(OUTPUT_DIR, 'latest.json'), JSON.stringify(meta, null, 2));

    console.log(
      `✅ Hotovo: ${path.relative(ROOT, OUTPUT_FILE)} | ${v.width}x${v.height} | ${v.codec_name} | ${v.pix_fmt} | ` +
      `${v.r_frame_rate} FPS | zvuk ${a ? `${a.codec_name} ${a.sample_rate} Hz` : 'žádný'} | ` +
      `${Number(info.format.duration).toFixed(2)} s | ${(info.format.size / 1024 / 1024).toFixed(2)} MB | ` +
      `${((Date.now() - started) / 1000).toFixed(1)} s`
    );
  } catch (err) {
    console.error('❌ Generování selhalo:', err);
    if (browser) await browser.close().catch(() => {});
    process.exit(1);
  }
})();
