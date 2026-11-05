'use strict';

/**
 * Animace: Puppeteer otevře template.html, pro každý snímek (30 FPS) nastaví přesný čas
 * přes R.seek(t), pořídí snímek obrazovky a pošle ho rovnou do FFmpegu (image2pipe).
 * Animace je tak plynulá a deterministická bez ohledu na výkon stroje.
 */

const fs = require('fs');
const path = require('path');
const { PassThrough } = require('stream');
const { pathToFileURL } = require('url');
const puppeteer = require('puppeteer');
const ffmpeg = require('fluent-ffmpeg');

const WIDTH = 1080;
const HEIGHT = 1920;

async function openTemplate(templatePath) {
  const browser = await puppeteer.launch({
    headless: true,
    // --no-sandbox je nutné na GitHub Actions (Ubuntu 24.04 omezuje user namespaces)
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none', '--hide-scrollbars'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('⚠️  Chyba v šabloně:', err.message));
  try {
    await page.goto(pathToFileURL(templatePath).href, { waitUntil: 'networkidle0', timeout: 30000 });
  } catch (err) {
    console.warn(`⚠️  Načítání šablony vypršelo (${err.message}), pokračuji.`);
  }
  await page.waitForFunction(() => window.R && typeof window.R.seek === 'function', { timeout: 10000 });
  return { browser, page };
}

/** Spočítá časování scén v šabloně (jediný zdroj pravdy pro web i Node). */
function buildTimeline(page, slides, voices) {
  return page.evaluate((s, v) => window.R.buildTimeline(s, v), slides, voices);
}

/**
 * Vyrenderuje všechny snímky do video souboru (bez zvuku).
 * @returns {Promise<{frames:number, coverFile:string}>}
 */
async function renderVideo(page, data, { fps, out, coverFile, coverTime }) {
  await page.evaluate((d) => window.R.setup(d), data);

  const frames = Math.round(data.duration * fps);
  const coverFrame = Math.min(frames - 1, Math.round(coverTime * fps));
  const stream = new PassThrough();

  const done = new Promise((resolve, reject) => {
    ffmpeg()
      .input(stream)
      .inputFormat('image2pipe')
      .inputOptions([`-framerate ${fps}`, '-c:v mjpeg'])
      .outputOptions([
        '-c:v libx264',
        '-preset medium',
        '-profile:v high',
        '-level 4.1',
        '-crf 18',
        '-pix_fmt yuv420p',
        `-r ${fps}`,
        `-g ${fps * 2}`,
        '-an',
      ])
      .output(out)
      .on('error', (err, _o, stderr) => reject(new Error(`${err.message}\n${(stderr || '').slice(-1500)}`)))
      .on('end', resolve)
      .run();
  });

  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.R.seek(t), f / fps);
    const buf = await page.screenshot({ type: 'jpeg', quality: 94, optimizeForSpeed: true });
    if (f === coverFrame && coverFile) fs.writeFileSync(coverFile, buf);
    if (!stream.write(buf)) await new Promise((r) => stream.once('drain', r));
    if (f % fps === 0 || f === frames - 1) {
      const pct = Math.round(((f + 1) / frames) * 100);
      const eta = ((Date.now() - started) / (f + 1)) * (frames - f - 1) / 1000;
      process.stdout.write(`\r🖼️  Snímky ${f + 1}/${frames} (${pct} %, zbývá ~${eta.toFixed(0)} s)   `);
    }
  }
  stream.end();
  process.stdout.write('\n');
  await done;
  return { frames };
}

module.exports = { openTemplate, buildTimeline, renderVideo };
