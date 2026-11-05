'use strict';

/**
 * Zvuková stopa: voiceover + podkresová hudba + tikání hodin + „whoosh“ efekty na přechodech.
 *
 * Hudba i efekty se generují přímo FFmpegem (aevalsrc / anoisesrc) – žádné licencované
 * soubory. Hlas se normalizuje na -15 LUFS (doporučená hlasitost pro TikTok / Instagram),
 * hudba je pod ním v pevné úrovni a pod mluveným slovem se automaticky ztlumí (sidechain).
 */

const ffmpeg = require('fluent-ffmpeg');

const RATE = 48000;

// Akordy podkresu pro jednotlivé scény (Am – F – C – G), frekvence v Hz
const CHORDS = [
  [110.0, 220.0, 261.63, 329.63],
  [87.31, 174.61, 220.0, 261.63],
  [130.81, 261.63, 329.63, 392.0],
  [98.0, 196.0, 246.94, 293.66],
];

function chordExpr([bass, ...notes]) {
  const tones = notes.map((f) => `sin(2*PI*${f}*t)+0.25*sin(4*PI*${f}*t)`).join('+');
  return `(${tones}+0.8*sin(2*PI*${bass}*t))`;
}

// Výraz pro aevalsrc: akord se mění na hranici každé scény
function musicExpr(boundaries) {
  let expr = chordExpr(CHORDS[boundaries.length % CHORDS.length]);
  for (let i = boundaries.length - 1; i >= 0; i--) {
    expr = `if(lt(t,${boundaries[i].toFixed(3)}),${chordExpr(CHORDS[i % CHORDS.length])},${expr})`;
  }
  // jemné „dýchání“ hlasitosti
  return `0.05*${expr}*(0.78+0.22*sin(2*PI*0.5*t))`;
}

/**
 * @param {object} p
 * @param {Array<{file:string}>} p.voices    soubory voiceoveru (po scénách)
 * @param {Array<{start:number,voiceStart:number}>} p.scenes  časování scén
 * @param {number} p.duration  celková délka videa (s)
 * @param {number} p.tempo     zrychlení voiceoveru (atempo)
 * @param {boolean} p.music    přidat hudbu a efekty
 * @param {number}  p.musicGain zesílení hudby (např. 2.5 pro video bez hlasu)
 * @param {string} p.out       výstupní soubor (.m4a)
 */
function buildAudio({ voices, scenes, duration, tempo = 1, music = true, musicGain = 1, out }) {
  return new Promise((resolve, reject) => {
    const T = duration.toFixed(3);
    const cmd = ffmpeg();
    const filters = [];

    voices.forEach((v) => cmd.input(v.file));
    const n = voices.length;

    voices.forEach((v, i) => {
      const ms = Math.round(scenes[i].voiceStart * 1000);
      const tempoF = tempo !== 1 ? `atempo=${tempo.toFixed(4)},` : '';
      filters.push(
        `[${i}:a]aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,${tempoF}` +
        `highpass=f=70,acompressor=threshold=0.125:ratio=3:attack=5:release=120,` +
        `adelay=${ms}|${ms},apad=whole_dur=${T}[v${i}]`
      );
    });
    // hlas se normalizuje zvlášť (-15 LUFS), hudba zůstává v pevné úrovni pod ním
    filters.push(
      `${voices.map((_, i) => `[v${i}]`).join('')}amix=inputs=${n}:normalize=0:duration=longest,` +
      `loudnorm=I=-15:TP=-2:LRA=7,aresample=${RATE}[voice]`
    );

    if (music) {
      const boundaries = scenes.slice(1).map((s) => s.start);
      cmd.input(`aevalsrc='${musicExpr(boundaries)}':s=${RATE}:d=${T}`).inputFormat('lavfi');
      // tik-tak: dvě výšky střídavě každou půlsekundu
      cmd.input(`aevalsrc='if(lt(mod(t,1),0.5),sin(2*PI*2600*t),sin(2*PI*1900*t))*exp(-150*mod(t,0.5))':s=${RATE}:d=${T}`).inputFormat('lavfi');
      cmd.input(`anoisesrc=d=${T}:c=pink:r=${RATE}:a=0.6`).inputFormat('lavfi');

      const whoosh = boundaries.map((b) => `max(0,1-abs(t-${b.toFixed(3)})/0.32)`).join('+') || '0';
      filters.push(
        `[${n}:a]aformat=channel_layouts=stereo,lowpass=f=1800,aecho=0.8:0.75:70|140:0.28|0.2,volume=${musicGain.toFixed(2)},` +
        `afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, duration - 1.2).toFixed(3)}:d=1.2[pad]`,
        `[${n + 1}:a]aformat=channel_layouts=stereo,highpass=f=1200,volume=0.06[tick]`,
        `[pad][tick]amix=inputs=2:normalize=0[bed]`,
        `[voice]asplit=2[vo][sc]`,
        `[bed][sc]sidechaincompress=threshold=0.02:ratio=8:attack=15:release=350[duck]`,
        `[${n + 2}:a]aformat=channel_layouts=stereo,highpass=f=600,lowpass=f=5500,volume='0.5*(${whoosh})':eval=frame[sfx]`,
        `[vo][duck][sfx]amix=inputs=3:normalize=0:duration=first[mix]`
      );
    } else {
      filters.push('[voice]anull[mix]');
    }

    filters.push(`[mix]alimiter=limit=0.89:level=false,aresample=${RATE}[aout]`);

    cmd
      .complexFilter(filters)
      .outputOptions(['-map [aout]', '-c:a aac', '-b:a 160k', `-t ${T}`])
      .output(out)
      .on('error', (err, _o, stderr) => reject(new Error(`${err.message}\n${(stderr || '').slice(-1500)}`)))
      .on('end', () => resolve(out))
      .run();
  });
}

module.exports = { buildAudio };
