# GlitchLab — decision log

Every judgment call made while building GlitchLab, with the reason. Newest
decisions are appended to the relevant section.

## Repository & tooling

1. **App lives in `glitchlab/`, wired up as an npm workspace from the repo root.**
   The repository already contained an unrelated Rails app (`app/`, `public/`,
   `Gemfile`, …). Vite treats `public/` as its static folder, so putting the
   app at the root would have shipped Rails error pages in the build. A root
   `package.json` with `"workspaces": ["glitchlab"]` proxies `dev`, `build`,
   `test`, etc., so `npm install && npm run dev` still works from a clean clone
   at the root. The Rails files are untouched.
2. **TypeScript 6.0 instead of the newest 7.x.** `typescript-eslint` currently
   declares support for TS `<6.1`; 6.0 keeps lint and typecheck consistent.
3. **Playwright pinned to 1.56.1** because the container's pre-installed
   Chromium build (`chromium-1194`) belongs to that release — no browser
   download is needed.
4. **The reference repo is cloned to `./reference/` and git-ignored.** It was
   read only to understand the techniques; no code was copied (it has no
   licence). All algorithms are reimplemented from scratch.
5. **Fixture media is generated, never downloaded.** `scripts/gen-fixtures.mjs`
   computes PNGs in JS (tiny PNG writer on top of `zlib`) and uses the ffmpeg
   binary from the `@ffmpeg-installer/ffmpeg` dev dependency (an npm package,
   so no extra system install) for `testsrc` videos and JPEG/WebP conversions.
   `@ffprobe-installer/ffprobe` is used by the e2e tests to verify outputs.
6. **Unit tests get their own `tsconfig.test.json`** (Node types) so the app
   build never sees Node APIs.

## JPEG codec & databending

7. **A custom baseline JPEG encoder + tolerant decoder in TypeScript**
   (`src/codec/`) instead of the browser's codecs or a library. Reasons:
   - determinism: the exact bytes must be identical in the browser, the
     worker and Node tests (same seed → byte-identical output);
   - control: the databend functions need to know the exact file layout
     (one DQT segment per table, 4 DHT tables, one interleaved scan);
   - the decoder must behave like libjpeg on damaged data — keep going and
     smear/garble instead of throwing — and report *structural* failure so
     the retry/fallback safety net has something to react to;
   - effects stay DOM-free and testable.
   Encoded files are standard-conformant (verified against ffmpeg's decoder in
   the unit tests), so the "glitched JPEG raw" download opens in other viewers.
8. **Huffman tables:** the Annex-K example tables. The AC symbol lists are
   written as the first 48 symbols followed by the remaining run/size symbols
   generated programmatically; tests assert each table is a complete, valid
   prefix code containing every symbol exactly once.
9. **Chroma subsampling: 4:2:0 below quality 90, 4:4:4 from 90 up.** 4:2:0
   gives the classic 16×16 colour-block glitch look at glitch-friendly
   qualities; 4:4:4 at high quality makes "neutral params ≈ unchanged image"
   hold (4:2:0 costs ~10 dB PSNR on hard colour edges).
10. **Databend corruption order follows the camera:** zigzag → DQT → DHT →
    scan → chroma.
11. **DQT:** "boost low / zero high" is implemented as multiplying quantisers
    k=1..lowCut by up to ~10× and pulling k≥highCut towards the minimum. The
    minimum written is **1, not 0**: a zero quantiser is illegal in the spec
    and some decoders reject it, which would break the raw-JPEG export.
    A quantiser of 1 already makes those coefficients negligible. DC is kept.
12. **DHT:** symbols are permuted only *within groups sharing the same
    magnitude category* (the low nibble). Code lengths and the number of extra
    bits read stay the same, so the stream stays in sync while run-lengths land
    on the wrong coefficients (structural smearing rather than noise). Above
    intensity 0.75 one code may additionally be moved to a longer length —
    still a valid prefix code — which desynchronises decoding for a harsher
    look. DC tables are never touched (that desyncs everything instantly).
13. **Scan:** bytes are only changed if neither they nor the previous byte are
    0xFF (so markers and stuffed `FF 00` pairs survive) and 0xFF is never
    written. Intensity blends three corruption styles: single bit flips → random
    bytes → short "transplants" of bytes from another part of the scan (the
    camera's approach).
14. **Scan "byte count" is per megapixel** ("Bytes / MP"). A fixed count would
    look far more destructive in the 720 px preview than in the full-res export;
    normalising by area keeps preview and export visually consistent.
15. **Chroma:** amplifies chroma-table DC/mid-AC quantisers; above 0.4 it may
    swap the Cb/Cr scan selectors (hue swap); above 0.75 it may point a chroma
    component at the luma quant table.
16. **Zigzag:** cyclic rotation of the 63 AC quantisers by up to 40 places,
    plus a few random swaps scaled by intensity.
17. **Safety net definition.** A decode "fails" when the file is structurally
    invalid, the output is blank (luma std-dev < 1 while the input had > 4), or
    fewer than 25 % of MCUs received real data. Then intensities are halved and
    it retries (up to 3 retries, each with a derived seed), then falls back to
    the previous good frame (video) or the clean JPEG round-trip / input. A
    unit test injects a failing decoder to prove the whole chain.
18. **Raw JPEG export = the bytes produced by the databend stage.** Effects that
    run *after* databend in the pipeline cannot be part of a JPEG's bytes, so
    they are not included; the option is disabled when databend is off.

## Effects

19. **Every effect has a `mix` (0–1) parameter.** Palette, ASCII etc. have no
    natural "neutral" setting; `mix` gives every effect an identity point (and
    is useful creatively).
20. **Effect signature** is `(img, params, rng, ctx)`; `ctx` carries the
    preview scale, frame index/time, per-effect temporal state and side outputs
    (ASCII text, JPEG bytes, notes). `Img` is a structural twin of `ImageData`
    so the same code runs in Node, workers and the main thread.
21. **Pixel-unit parameters scale with the preview.** Parameters marked
    `pixels` (8-bit block size, ASCII cell size, datamosh block size) are
    multiplied by preview-width / full-width, so the 720 px preview looks like
    the export.
22. **Seeds per effect and frame:** `rng = mulberry32(hash(seed, effectType,
    frameIndex))`, so reordering effects does not change each effect's random
    stream, and every video frame gets fresh glitches (the classic flicker).
23. **Viewfinder palettes** are the camera's five RGB565 4-tone palettes
    converted to 8-bit RGB. "Tone count" 2–8 resamples the palette gradient.
    Custom palettes take 2–8 colours as gradient stops.
24. **8-bit "256-colour" = RGB 3-3-2**; **CGA = mode-4 palette 1 high intensity**
    (black/cyan/magenta/white), the iconic 4-colour look; Game Boy = the classic
    four greens. Quantisation happens on the block grid, so dithering and
    palette mapping produce clean uniform blocks.
25. **ASCII glyphs** are rasterised in the worker with `OffscreenCanvas`
    (platform monospace font) into a coverage atlas passed to the pure effect;
    in tests a synthetic atlas is used. Block shades (░▒▓█) are drawn as
    patterns so they fill the cell regardless of font. The classic set is used
    exactly as specified (`.:-=+*#%@`, dark → bright). Cells are 0.6 em wide.
26. **Pixel sort** packs `key << 16 | index` into a `Uint32Array` and uses the
    native typed-array sort for speed; spans shorter than 2 px are skipped.
27. **Crop** is stored as a normalised box plus an aspect preset; ratio presets
    shrink the box around its centre to the exact ratio. The crop box is edited
    on a preview rendered with geometry skipped. Order inside geometry: crop →
    rotate → flip → scale.

## Built-in presets

28. The six presets were tuned by rendering them side by side and adjusting
    until each is clearly distinct and still readable (the first versions of
    "CyberShot Green" and "Heavy Glitch" destroyed the picture completely).
    A unit test enforces pairwise distinctness (mean abs diff > 10).
    "Light Trails" uses lighten-stacking on video and a vertical highlight
    pixel sort so it is still distinctive on stills.

## Architecture

29. **ffmpeg.wasm core used directly inside our processing worker**
    (`@ffmpeg/core`, single-threaded) rather than through `@ffmpeg/ffmpeg`'s
    class, which would spawn a *second, nested* worker and copy every raw frame
    between the two. Loading the core in our own worker keeps frames in one
    place and needs no `SharedArrayBuffer`, so no COOP/COEP headers.
30. **Two worker instances:** one for previews (latest request wins; stale
    queued requests are dropped) and one for exports. **Cancel = terminate the
    export worker** — the only way to stop an ffmpeg run in progress; it is
    recreated lazily.
31. **HEIC is not supported** (browsers cannot decode it and a wasm HEIF decoder
    would add megabytes). HEIC files are rejected with a clear message.

## Video

32. **Streaming in chunks.** Frames are decoded with `-ss <t> -i … -frames:v K`
    into raw RGBA chunks of ≤ 48 MB, processed, and each chunk is encoded to its
    own segment file (which is then deleted from MEMFS as raw data); segments are
    joined with ffmpeg's concat demuxer (`-c copy`). Peak memory is one raw
    chunk plus compressed segments, independent of clip length. (ffmpeg.wasm
    can't stream stdin/stdout, so this is the practical way to bound memory.)
33. **Frame-exact output length.** The output has exactly
    `floor((end − start) / speed × fps)` frames; if the decoder returns fewer
    at the end of the clip, the last frame is repeated. Tests verify counts.
34. **Timing filters:** `setpts=(PTS−STARTPTS)/speed, fps=<out>, scale=W:H`.
    "half" fps = source fps / 2; custom fps 1–60; speed 0.25–4× in the UI
    (0.1–8× accepted in presets).
35. **Audio is dropped.** Speed changes, trims and stacking would need matching
    audio processing; GlitchLab outputs silent video. Documented as a limitation.
36. **WebM uses VP8** (`libvpx`, realtime/cpu-used 8). VP9 in single-threaded
    wasm is several times slower; VP8 plays everywhere WebM does.
37. **MP4 = H.264** (`libx264 veryfast`, CRF 20, yuv420p, GOP = 1 s), `+faststart`.
    Frames are cropped to even dimensions for yuv420p.
38. **GIF** is rendered at the chosen GIF fps and width directly (fewer, smaller
    frames to process; pixel-size params scale along), encoded to a high-quality
    H.264 intermediate, then a `palettegen (stats_mode=diff)` + `paletteuse
    (bayer)` pass builds a palette-optimised GIF.
39. **Caps:** by default clips are downscaled to fit 1920×1080 and limited to
    60 s after the trim start, with a visible warning (never an error). A
    "Lift 1080p / 60 s caps" switch removes them at the user's own risk.
40. **Stacking runs on the source frames, before the effect pipeline** (long
    exposure is a capture technique, glitches come after). It is a video
    setting, not a pipeline effect, because its "single still" output mode
    changes the export type. Rolling window is capped at 30 frames (a ring
    buffer of full frames; 30 × 1080p ≈ 250 MB). The still mode folds every
    frame into running sums/max/min: O(1) memory.
41. **Datamosh-lite interpretation:** every `hold` frames a keyframe is taken;
    in between, per-block motion between consecutive source frames is estimated
    by SAD block matching on a ¼-scale luma plane (±12 px) and applied to the
    *held* picture, plus a configurable share of the frame-to-frame residual —
    which is what real I-frame-dropping datamoshes look like. The "glitch
    intensity ramp" is the blend from the real frame to the moshed frame,
    ramping from `rampFrom` to `rampTo` across each hold. It is a normal,
    reorderable pipeline effect (so e.g. databend can run after it) and a no-op
    on stills.
42. **Parameter animation:** any range parameter can be animated; the slider
    value is the clip-start value and a second slider sets the clip-end value;
    `t = frame / (frames − 1)`. The ◆ buttons only appear for videos; still
    exports use the start value.
43. **Temporal previews are approximated:** the scrubber preview decodes only
    the history it needs (stack window − 1 frames, and frames since the last
    datamosh keyframe), capped at 29 + 40 frames, at preview resolution. For
    history frames only the pipeline prefix up to datamosh is run
    (`stopAfter`). The still-stack preview samples ≤ 48 frames evenly; export
    uses every frame.
44. **Video → image exports:** with a video loaded, PNG/JPEG/WebP export the
    frame under the scrubber (rendered as a still) or, in stacking "single
    still" mode, the full-resolution stack of every frame.
45. **Video probing** parses `ffmpeg -i` output (duration, size, fps, rotation
    metadata → width/height swapped for 90° rotations, since ffmpeg autorotates
    on decode).

## UI

46. **Layout:** file strip (150 px) | preview | parameter panel (350 px); at
    1280×800 the preview gets ~780 px. Below 760 px wide the strip becomes a
    horizontal row and the panel a fixed bottom sheet (collapsed to a 48 px
    handle, expands to 62 vh).
47. **Preview debounce is 90 ms** after the last change (well inside the
    ≤ 150 ms budget); the preview worker additionally drops queued stale
    requests, so fast slider drags never pile up work.
48. **Preview display scale:** shrink smoothly to fit, but only enlarge by
    whole factors with `image-rendering: pixelated`. Non-integer upscaling of
    dithered output produced visible moiré (spotted in the M8 screenshots).
49. **Before/after:** "⇆ split" toggles a draggable divider (off by default so
    the output is seen whole); Space / "◐ before" shows the original. If
    geometry changed the output size, both sides are letterboxed (`object-fit:
    contain`) rather than stretched.
50. **One instance of each effect**, always present in the pipeline and toggled
    on/off, rather than an "add effect" menu with duplicates: simpler UI, and
    presets stay small and comparable.
51. **Any manual change marks the pipeline "custom"** (used in file names);
    loading a preset resets stacking unless the preset sets it.
52. **Batch applies to every loaded file**: images use the chosen image format
    (PNG if a video format is selected), videos use the chosen video format.
    Duplicate names in the ZIP get `-2`, `-3` suffixes. ZIP entries are stored
    (level 0), since PNG/JPEG/MP4 are already compressed.

## Testing & docs

53. **e2e runs against the production build** (`vite build && vite preview`) —
    what gets deployed — with `E2E_DEV=1` to target the dev server; both were
    run. Screenshots are written to `glitchlab/screenshots/` (git-ignored;
    Playwright wipes `test-results/` on every run); the ones used in the README
    are copied to `glitchlab/docs/screenshots/`.
54. **UI responsiveness is measured**, not assumed: e2e tests run a
    `requestAnimationFrame` loop during exports and assert the longest gap is
    < 500 ms (observed: a few dozen ms).
55. **The main README lives at the repository root** (replacing the one-line
    `readme.md` placeholder, renamed rather than duplicated to avoid a
    `README.md`/`readme.md` clash on case-insensitive file systems);
    `glitchlab/README.md` points to it.
56. **Licensing:** the `@ffmpeg/core` wasm build is GPL-2.0-or-later (it
    includes x264). This is noted in the README because a deployed `dist/`
    redistributes it.
57. **Root proxy scripts end in `--`** (`npm run dev -w glitchlab --`) so extra
    arguments reach the tool: without it, `npm run dev -- --port 3000` at the
    root had npm swallow `--port` as its own config (found in the clean-clone
    check).
