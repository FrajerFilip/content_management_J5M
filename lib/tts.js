'use strict';

/**
 * Voiceover (text-to-speech) s více poskytovateli.
 *
 *   piper       – open-source, běží lokálně na GitHub Actions, zdarma, bez klíče (výchozí)
 *   elevenlabs  – nejpřirozenější čeština, vyžaduje ELEVENLABS_API_KEY (přesné časy slov)
 *   openai      – vyžaduje OPENAI_API_KEY
 *   none        – bez hlasu (ticho odhadnuté délky)
 *   auto        – elevenlabs → openai → piper podle dostupných klíčů
 *
 * Každý poskytovatel vrací { file, duration, words } – words jsou časy slov v sekundách
 * relativně k začátku audia (pro titulky), nebo null (pak se odhadnou v šabloně).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

const PIPER_PYTHON = process.env.PIPER_PYTHON || 'python3';
const PIPER_VOICE = process.env.PIPER_VOICE || 'cs_CZ-jirka-medium';
const PIPER_DATA_DIR = process.env.PIPER_DATA_DIR || path.join(__dirname, '..', 'voices');

const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB'; // „Adam“, multilingual
const ELEVEN_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
const OPENAI_MODEL = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
const OPENAI_VOICE = process.env.OPENAI_TTS_VOICE || 'ash';

function resolveProvider(requested) {
  const p = String(requested || 'auto').toLowerCase();
  if (p !== 'auto') return p;
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'piper';
}

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} skončil kódem ${code}: ${stderr.slice(-800)}`))));
    if (input !== undefined) child.stdin.end(input);
  });
}

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(Number(data.format.duration))));
  });
}

// --- poskytovatelé ----------------------------------------------------------

async function piper(text, out, { speed }) {
  const file = `${out}.wav`;
  await run(PIPER_PYTHON, [
    '-m', 'piper',
    '-m', PIPER_VOICE,
    '--data-dir', PIPER_DATA_DIR,
    '-f', file,
    '--length-scale', String((1 / speed).toFixed(3)),
    '--sentence-silence', '0.12',
  ], text);
  return { file, words: null };
}

async function elevenlabs(text, out, { speed }) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Chybí ELEVENLABS_API_KEY (GitHub Secrets).');
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(ELEVEN_VOICE)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, speed: Math.min(1.2, Math.max(0.7, speed)) },
      }),
    }
  );
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const file = `${out}.mp3`;
  fs.writeFileSync(file, Buffer.from(json.audio_base64, 'base64'));

  // znaky → slova
  const a = json.alignment || json.normalized_alignment;
  let words = null;
  if (a && a.characters) {
    words = [];
    let cur = null;
    a.characters.forEach((ch, i) => {
      if (/\s/.test(ch)) { if (cur) { words.push(cur); cur = null; } return; }
      if (!cur) cur = { w: '', s: a.character_start_times_seconds[i], e: 0 };
      cur.w += ch;
      cur.e = a.character_end_times_seconds[i];
    });
    if (cur) words.push(cur);
  }
  return { file, words };
}

async function openai(text, out, { speed }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Chybí OPENAI_API_KEY (GitHub Secrets).');
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      voice: OPENAI_VOICE,
      input: text,
      response_format: 'mp3',
      instructions: `Mluv česky, přirozeně a energicky jako mladý tvůrce videí pro TikTok. Mluv k vysokoškolákům, přátelsky a s lehkým humorem.${speed > 1.05 ? ' Mluv svižněji než obvykle.' : speed < 0.95 ? ' Mluv klidněji a pomaleji.' : ''}`,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const file = `${out}.mp3`;
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { file, words: null };
}

function silence(text, out, { speed }) {
  const file = `${out}.wav`;
  const dur = Math.max(1.2, text.length / 15.5 / speed);
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input('anullsrc=channel_layout=mono:sample_rate=48000').inputFormat('lavfi')
      .outputOptions([`-t ${dur.toFixed(3)}`])
      .output(file)
      .on('error', reject)
      .on('end', () => resolve({ file, words: null }))
      .run();
  });
}

const PROVIDERS = { piper, elevenlabs, openai, none: silence };

/**
 * Namluví všechny texty. Vrací { provider, voices: [{ file, duration, words, text }] }.
 */
async function synthesizeAll(texts, dir, { provider: requested = 'auto', speed = 1 } = {}) {
  const provider = resolveProvider(requested);
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`Neznámý poskytovatel hlasu „${provider}“ (piper | elevenlabs | openai | none | auto).`);

  const voices = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const out = path.join(dir, `voice-${String(i + 1).padStart(2, '0')}`);
    const { file, words } = await fn(text, out, { speed });
    const duration = await probeDuration(file);
    voices.push({ file, duration, words, text });
    console.log(`🎙️  Voiceover ${i + 1}/${texts.length} (${provider}): ${duration.toFixed(2)} s – „${text}“`);
  }
  return { provider, voices };
}

module.exports = { synthesizeAll, resolveProvider };
