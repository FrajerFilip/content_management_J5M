'use strict';

/**
 * Voiceover (text-to-speech) s více poskytovateli.
 *
 *   elevenlabs  – nejpřirozenější a nejvýraznější čeština (ELEVENLABS_API_KEY), přesné časy slov,
 *                 plynulá návaznost mezi snímky (previous_text / next_text)
 *   azure       – oficiální Azure AI Speech, neuronové hlasy Antonín / Vlasta (AZURE_SPEECH_KEY + AZURE_SPEECH_REGION)
 *   openai      – gpt-4o-mini-tts s režií tónu a tempa (OPENAI_API_KEY)
 *   piper       – open-source, zdarma, bez klíče – běží přímo na GitHub Actions (zní strojověji)
 *   none        – bez hlasu (ticho odhadnuté délky)
 *   auto        – elevenlabs → azure → openai → piper podle dostupných klíčů
 *
 * Každý poskytovatel vrací { file, words } – words jsou časy slov v sekundách
 * relativně k začátku audia (pro titulky), nebo null (pak se odhadnou v šabloně).
 * Všechny nahrávky se pak ořežou o ticho; hlas z Piperu navíc projde zvukovou úpravou.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

const env = (name, fallback) => (process.env[name] && process.env[name].trim()) || fallback;

// Piper
const PIPER_PYTHON = env('PIPER_PYTHON', 'python3');
const PIPER_VOICE = env('PIPER_VOICE', 'cs_CZ-jirka-medium');
const PIPER_DATA_DIR = env('PIPER_DATA_DIR', path.join(__dirname, '..', 'voices'));
// Piper mluví v základu pomaleji – 0,88 = o ~12 % svižnější řeč (menší = rychlejší)
const PIPER_LENGTH_SCALE = Number(env('PIPER_LENGTH_SCALE', '0.88'));
// Víc variability v intonaci a délce hlásek = méně monotónní projev (výchozí Piper: 0.667 / 0.8)
const PIPER_NOISE_SCALE = env('PIPER_NOISE_SCALE', '0.72');
const PIPER_NOISE_W = env('PIPER_NOISE_W', '0.9');

// ElevenLabs – hlas vyber ve Voice Library (ideálně rodilý český mluvčí) a ulož jeho ID
// do proměnné ELEVENLABS_VOICE_ID; výchozí hlasy jsou multijazyčné, ne nativně české.
const ELEVEN_VOICES = { male: 'pNInz6obpgDQGcFmaJgB', female: 'EXAVITQu4vr4xnSDxMaL' }; // Adam / Sarah
const ELEVEN_MODEL = env('ELEVENLABS_MODEL', 'eleven_multilingual_v2');

// Azure AI Speech (oficiální API, bezplatná úroveň F0)
const AZURE_VOICES = { male: 'cs-CZ-AntoninNeural', female: 'cs-CZ-VlastaNeural' };

// OpenAI
const OPENAI_MODEL = env('OPENAI_TTS_MODEL', 'gpt-4o-mini-tts');
const OPENAI_VOICES = { male: 'ash', female: 'coral' };

// Režie projevu – společná pro poskytovatele, kteří ji umí využít
const DIRECTION = [
  'Jazyk: čeština, rodilý mluvčí, přirozená výslovnost a přízvuk na první slabice.',
  'Projev: mladý, sympatický tvůrce videí na TikToku mluví ke spolužákům z vysoké školy.',
  'Tón: vřelý, energický, s lehkým úsměvem a nadhledem, nikdy nekáže.',
  'Tempo: svižné, ale s krátkými pauzami po čárkách a výraznou intonací otázek.',
  'Důraz: zvýrazni klíčová slova a pointu na konci věty.',
].join(' ');

function resolveProvider(requested) {
  const p = String(requested || 'auto').toLowerCase();
  if (p !== 'auto') return p;
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.AZURE_SPEECH_KEY) return 'azure';
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

async function apiError(name, res) {
  const body = (await res.text()).slice(0, 300);
  const hint = res.status === 401 || res.status === 403 ? ' – zkontroluj API klíč v GitHub Secrets.' : '';
  return new Error(`${name} ${res.status}: ${body}${hint}`);
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- poskytovatelé ----------------------------------------------------------

async function piper({ text, out, speed }) {
  const file = `${out}.wav`;
  await run(PIPER_PYTHON, [
    '-m', 'piper',
    '-m', PIPER_VOICE,
    '--data-dir', PIPER_DATA_DIR,
    '-f', file,
    '--length-scale', String((PIPER_LENGTH_SCALE / speed).toFixed(3)),
    '--noise-scale', PIPER_NOISE_SCALE,
    '--noise-w-scale', PIPER_NOISE_W,
    '--sentence-silence', '0.12',
  ], text);
  return { file, words: null };
}

async function elevenlabs({ text, out, speed, gender, prev, next }) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('Chybí ELEVENLABS_API_KEY (GitHub Secrets).');
  const voice = env('ELEVENLABS_VOICE_ID', ELEVEN_VOICES[gender]);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL,
        // okolní snímky = plynulá intonace napříč celým videem, ne 4 izolované věty
        previous_text: prev || undefined,
        next_text: next || undefined,
        voice_settings: {
          stability: 0.38,          // nižší = živější, emotivnější projev
          similarity_boost: 0.8,
          style: 0.35,              // výraznější styl mluvčího
          use_speaker_boost: true,
          speed: Math.min(1.2, Math.max(0.7, speed)),
        },
      }),
    }
  );
  if (!res.ok) throw await apiError('ElevenLabs', res);
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

async function azure({ text, out, speed, gender }) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = env('AZURE_SPEECH_REGION', 'westeurope');
  if (!key) throw new Error('Chybí AZURE_SPEECH_KEY (GitHub Secrets).');
  const voice = env('AZURE_TTS_VOICE', AZURE_VOICES[gender]);
  const rate = `${Math.round((speed * 1.06 - 1) * 100)}%`; // o kousek svižnější než výchozí tempo
  // krátké pauzy po čárkách a otázkách pomáhají přirozenému frázování
  const body = escapeXml(text)
    .replace(/, /g, ',<break time="120ms"/> ')
    .replace(/\? /g, '?<break time="220ms"/> ');
  const ssml =
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="cs-CZ">` +
    `<voice name="${voice}"><prosody rate="${rate.startsWith('-') ? rate : `+${rate}`}" pitch="+2%">${body}</prosody></voice></speak>`;
  const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'riff-48khz-16bit-mono-pcm',
      'User-Agent': 'reels-generator',
    },
    body: ssml,
  });
  if (!res.ok) throw await apiError('Azure Speech', res);
  const file = `${out}.wav`;
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { file, words: null };
}

async function openai({ text, out, speed, gender }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Chybí OPENAI_API_KEY (GitHub Secrets).');
  const tempo = speed > 1.05 ? ' Mluv o něco rychleji než obvykle.' : speed < 0.95 ? ' Mluv klidněji a pomaleji.' : '';
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      voice: env('OPENAI_TTS_VOICE', OPENAI_VOICES[gender]),
      input: text,
      response_format: 'wav',
      instructions: DIRECTION + tempo,
    }),
  });
  if (!res.ok) throw await apiError('OpenAI', res);
  const file = `${out}.wav`;
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return { file, words: null };
}

function silence({ text, out, speed }) {
  const file = `${out}.wav`;
  const dur = Math.max(1.2, text.length / 11.7 / speed);
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

const PROVIDERS = { elevenlabs, azure, openai, piper, none: silence };

// --- zvuková úprava ---------------------------------------------------------

const TRIM = [
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.03',
  'areverse',
  'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08',
  'areverse',
];

// „Vokální řetězec“ pro syntetický hlas: méně plechový a ostrý, plnější a blíž posluchači
const POLISH = [
  'aresample=48000:resampler=soxr',
  'highpass=f=75',
  'equalizer=f=180:t=q:w=1.0:g=2',      // tělo / hloubka hlasu
  'equalizer=f=450:t=q:w=1.2:g=-2.5',   // ubere „krabicový“ zvuk
  'equalizer=f=2800:t=q:w=1.4:g=-1.5',  // zjemní kovovou složku syntézy
  'equalizer=f=5000:t=q:w=1.0:g=1.5',   // srozumitelnost
  'deesser=i=0.4:m=0.5:f=0.5',
  'treble=g=2:f=9000',                  // vzduch
  'acompressor=threshold=0.1:ratio=3:attack=8:release=140:makeup=1.5',
  'aecho=0.9:0.5:22|37:0.07|0.05',      // velmi jemný prostor, ať hlas nezní „ve vakuu“
];

function processVoice(file, out, polish) {
  return new Promise((resolve, reject) => {
    ffmpeg(file)
      .audioFilters(polish ? [...TRIM, ...POLISH] : TRIM)
      .audioCodec('pcm_s16le')
      .output(out)
      .on('error', (err, _o, stderr) => reject(new Error(`${err.message}\n${(stderr || '').slice(-800)}`)))
      .on('end', () => resolve(out))
      .run();
  });
}

/**
 * Namluví všechny texty. Vrací { provider, voices: [{ file, duration, words, text }] }.
 * @param {string[]} texts
 * @param {string} dir
 * @param {{provider?: string, speed?: number, gender?: 'male'|'female'}} opts
 */
async function synthesizeAll(texts, dir, { provider: requested = 'auto', speed = 1, gender = 'male' } = {}) {
  const provider = resolveProvider(requested);
  const fn = PROVIDERS[provider];
  if (!fn) throw new Error(`Neznámý poskytovatel hlasu „${provider}“ (elevenlabs | azure | openai | piper | none | auto).`);
  if (provider === 'piper' && gender === 'female') console.warn('ℹ️  Piper má jen mužský český hlas – pro ženský hlas použij Azure, OpenAI nebo ElevenLabs.');

  const voices = [];
  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const out = path.join(dir, `voice-${String(i + 1).padStart(2, '0')}`);
    const raw = await fn({ text, out, speed, gender, prev: texts.slice(0, i).join(' '), next: texts.slice(i + 1).join(' ') });
    let { file, words } = raw;
    if (provider !== 'none') {
      const before = await probeDuration(file);
      file = await processVoice(raw.file, `${out}-final.wav`, provider === 'piper');
      const after = await probeDuration(file);
      // přesné časy slov (ElevenLabs) posuneme o oříznuté ticho na začátku
      if (words && words.length) {
        const shift = Math.min(words[0].s, Math.max(0, before - after));
        words = words.map((w) => ({ ...w, s: Math.max(0, w.s - shift), e: Math.max(0, w.e - shift) }));
      }
    }
    const duration = await probeDuration(file);
    voices.push({ file, duration, words, text });
    console.log(`🎙️  Voiceover ${i + 1}/${texts.length} (${provider}): ${duration.toFixed(2)} s – „${text}“`);
  }
  return { provider, voices };
}

module.exports = { synthesizeAll, resolveProvider };
