import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { normalizePipeline, runPipeline } from '../../src/core/pipeline';
import { BUILTIN_PRESETS } from '../../src/core/presets';
const FF = '../node_modules/@ffmpeg-installer/linux-x64/ffmpeg';
const SP = '/tmp/claude-0/-home-user-honeybelle/35b59c2d-56de-5b73-9c3f-efcb7299c110/scratchpad';
it('render', () => {
  execFileSync(FF, ['-v','error','-y','-i','fixtures/scene.png','-f','rawvideo','-pix_fmt','rgba', SP + '/scene.rgba']);
  const data = new Uint8ClampedArray(readFileSync(SP + '/scene.rgba'));
  const img = { width: 960, height: 640, data };
  const names: string[] = [];
  for (const p of BUILTIN_PRESETS) {
    const t = performance.now();
    const out = runPipeline(img, normalizePipeline(p.pipeline)).img;
    console.log(p.name, Math.round(performance.now() - t), 'ms');
    const f = SP + '/' + p.name.replace(/\W+/g, '_');
    writeFileSync(f + '.rgba', out.data);
    execFileSync(FF, ['-v','error','-y','-f','rawvideo','-pix_fmt','rgba','-s', out.width + 'x' + out.height, '-i', f + '.rgba', '-vf', 'scale=480:-1', f + '.png']);
    names.push(f + '.png');
  }
  execFileSync(FF, ['-v','error','-y', ...names.flatMap((n) => ['-i', n]), '-filter_complex', '[0][1][2]hstack=3[t];[3][4][5]hstack=3[u];[t][u]vstack', SP + '/sheet.png']);
});
