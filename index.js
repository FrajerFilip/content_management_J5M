'use strict';

/**
 * Generátor informačních Reels / TikTok videí (18 s, 1080x1920, 30 FPS).
 *
 * 1) Dosadí data 4 snímků do template.html
 * 2) Puppeteer vyrenderuje 4 PNG (1080x1920) do temp/
 * 3) fluent-ffmpeg je spojí do output/reels-output.mp4 (každý snímek 4,5 s)
 */

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------
const WIDTH = 1080;
const HEIGHT = 1920;
const FPS = 30;
const SLIDE_DURATION = 4.5; // sekundy na snímek

const ROOT = __dirname;
const TEMPLATE_PATH = path.join(ROOT, 'template.html');
const TEMP_DIR = path.join(ROOT, 'temp');
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'reels-output.mp4');

// Volitelně vlastní cesta k binárce FFmpeg (jinak se použije ffmpeg z PATH)
if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);

// ---------------------------------------------------------------------------
// Testovací data – 4 navazující snímky
// ---------------------------------------------------------------------------
const slides = [
  {
    type: 'hook',
    heading: 'Pijete málo vody? 💧',
    mainText: 'Už <strong>2 % dehydratace</strong> sníží vaši koncentraci. Tohle musíte vědět!',
    imageUrl: 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=1080&h=1920&fit=crop&q=80',
  },
  {
    type: 'info',
    heading: 'Mozek je ze 75 % voda',
    mainText: 'Při nedostatku tekutin se zpomaluje reakční doba a roste únava. Mozek to pozná <strong>dřív než žízeň</strong>.',
    imageUrl: 'https://images.unsplash.com/photo-1559757175-5700dde675bc?w=1080&h=1920&fit=crop&q=80',
  },
  {
    type: 'info',
    heading: 'Kolik vody denně?',
    mainText: 'Orientačně <strong>30–35 ml na 1 kg</strong> tělesné váhy. Při sportu a v horku ještě víc.',
    imageUrl: 'https://images.unsplash.com/photo-1523362628745-0c100150b504?w=1080&h=1920&fit=crop&q=80',
  },
  {
    type: 'cta',
    heading: 'Sleduj pro další tipy! 🚀',
    mainText: 'Ulož si video, ať nezapomeneš, a <strong>pošli ho kamarádovi</strong>, který pořád zapomíná pít.',
    imageUrl: 'https://images.unsplash.com/photo-1490645935967-10de6ba17061?w=1080&h=1920&fit=crop&q=80',
  },
];

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------

/** Escapuje HTML, ale ponechá povolené tagy <strong>, <em>, <br>. */
function sanitize(text) {
  const escaped = String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped
    .replace(/&lt;(\/?)(strong|em|br)\s*\/?&gt;/gi, '<$1$2>')
    .replace(/\n/g, '<br>');
}

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function renderTemplate(template, slide) {
  return template
    .replace(/{{HEADING}}/g, sanitize(slide.heading))
    .replace(/{{MAIN_TEXT}}/g, sanitize(slide.mainText))
    .replace(/{{IMAGE_URL}}/g, escapeAttr(slide.imageUrl));
}

function prepareDir(dir, clean = false) {
  if (clean && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// 1) Render PNG snímků přes Puppeteer
// ---------------------------------------------------------------------------
async function renderSlides(slideData) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');

  const browser = await puppeteer.launch({
    headless: true,
    // --no-sandbox je nutné na GitHub Actions (Ubuntu 24.04 omezuje user namespaces)
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });

  const files = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });

    for (let i = 0; i < slideData.length; i++) {
      const slide = slideData[i];
      const html = renderTemplate(template, slide);

      try {
        await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
      } catch (err) {
        // Pomalé/nedostupné obrázky nebo fonty nesmí shodit celý běh
        console.warn(`⚠️  Snímek ${i + 1}: načítání vypršelo (${err.message}), pokračuji s tím, co je načteno.`);
      }

      // Počkej na fonty a dekódování obrázku
      await page.evaluate(async () => {
        await document.fonts.ready;
        const img = document.querySelector('img.bg');
        if (img && !img.complete) {
          await new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 10000);
          });
        }
      });

      const file = path.join(TEMP_DIR, `slide-${String(i + 1).padStart(2, '0')}.png`);
      await page.screenshot({
        path: file,
        type: 'png',
        clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
      });
      files.push(file);
      console.log(`🖼️  Vygenerován snímek ${i + 1}/${slideData.length} (${slide.type}): ${path.relative(ROOT, file)}`);
    }
  } finally {
    await browser.close();
  }

  return files;
}

// ---------------------------------------------------------------------------
// 2) Spojení PNG do MP4 přes fluent-ffmpeg
// ---------------------------------------------------------------------------
function buildVideo(images, outputFile) {
  return new Promise((resolve, reject) => {
    const totalDuration = images.length * SLIDE_DURATION;
    const cmd = ffmpeg();

    // Každý obrázek jako samostatný vstup, smyčkovaný přesně 4,5 s při 30 FPS
    images.forEach((img) => {
      cmd.input(img).inputOptions(['-loop 1', `-framerate ${FPS}`, `-t ${SLIDE_DURATION}`]);
    });

    // Tichá zvuková stopa – zvyšuje kompatibilitu s uploadery sociálních sítí
    cmd.input('anullsrc=channel_layout=stereo:sample_rate=44100').inputFormat('lavfi');

    // Normalizace každého snímku + spojení za sebe
    const filters = images.map(
      (_, i) =>
        `[${i}:v]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,` +
        `pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p[v${i}]`
    );
    const concatInputs = images.map((_, i) => `[v${i}]`).join('');
    filters.push(`${concatInputs}concat=n=${images.length}:v=1:a=0[outv]`);

    cmd
      .complexFilter(filters)
      .outputOptions([
        '-map [outv]',
        `-map ${images.length}:a`,
        '-c:v libx264',
        '-preset medium',
        '-profile:v high',
        '-level 4.1',
        '-crf 20',
        '-pix_fmt yuv420p',
        `-r ${FPS}`,
        `-g ${FPS * 2}`,
        '-c:a aac',
        '-b:a 128k',
        '-ar 44100',
        `-t ${totalDuration}`,
        '-movflags +faststart',
      ])
      .output(outputFile)
      .on('start', (line) => console.log(`🎬 FFmpeg: ${line}`))
      .on('progress', (p) => {
        if (p.timemark) process.stdout.write(`\r⏳ Kóduji… ${p.timemark}`);
      })
      .on('error', (err, _stdout, stderr) => {
        console.error('\n❌ FFmpeg chyba:', err.message);
        if (stderr) console.error(stderr);
        reject(err);
      })
      .on('end', () => {
        process.stdout.write('\n');
        resolve(outputFile);
      })
      .run();
  });
}

function probe(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const started = Date.now();
  try {
    prepareDir(TEMP_DIR, true);
    prepareDir(OUTPUT_DIR);

    console.log(`🚀 Generuji ${slides.length} snímky (${WIDTH}x${HEIGHT})…`);
    const images = await renderSlides(slides);

    console.log(`🎞️  Skládám video (${images.length} × ${SLIDE_DURATION} s = ${images.length * SLIDE_DURATION} s, ${FPS} FPS)…`);
    await buildVideo(images, OUTPUT_FILE);

    const info = await probe(OUTPUT_FILE);
    const v = info.streams.find((s) => s.codec_type === 'video');
    console.log(
      `✅ Hotovo: ${path.relative(ROOT, OUTPUT_FILE)} | ${v.width}x${v.height} | ${v.codec_name} | ${v.pix_fmt} | ` +
        `${v.r_frame_rate} FPS | ${Number(info.format.duration).toFixed(2)} s | ` +
        `${(info.format.size / 1024 / 1024).toFixed(2)} MB | ${((Date.now() - started) / 1000).toFixed(1)} s`
    );
  } catch (err) {
    console.error('❌ Generování selhalo:', err);
    process.exit(1);
  }
})();
