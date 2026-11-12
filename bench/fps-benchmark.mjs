/**
 * FPS benchmark for the 500K-point demo scene.
 *
 * Launches a real (headed, GPU-accelerated) Chrome, waits for the demo cloud
 * to load, then drives continuous orbit and pan mouse drags over the canvas
 * for N seconds while recording requestAnimationFrame timestamps in the page
 * (the viewer renders once per rAF, so rAF rate == render rate).
 *
 * Usage:
 *   npm run dev            # in another terminal
 *   npm run bench -- --url http://localhost:5173 --seconds 10
 *
 * Env: CHROME_PATH to override the Chrome executable.
 */
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const URL = arg('url', 'http://localhost:5173');
const SECONDS = Number(arg('seconds', 10));
const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 1000));
const CHROME =
  process.env.CHROME_PATH ??
  {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    linux: '/usr/bin/google-chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  }[process.platform];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  defaultViewport: null,
  args: [`--window-size=${WIDTH},${HEIGHT}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const page = await browser.newPage();
await page.goto(URL, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.__pointsLoaded === true, { timeout: 60_000 });
await new Promise((r) => setTimeout(r, 1500)); // let GPU upload + shader compile settle

const env = await page.evaluate(() => {
  const canvas = document.querySelector('canvas');
  const gl = canvas.getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown',
    canvasPx: `${canvas.width}x${canvas.height}`,
    devicePixelRatio: window.devicePixelRatio,
    points: document.body.innerText.match(/([\d,]+) points/)?.[1],
  };
});

// The 3D canvas is the first canvas (the sidebar sits to its left).
const box = await (await page.$('canvas')).boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;

await page.evaluate(() => {
  window.__frames = [];
  const loop = (t) => {
    window.__frames.push(t);
    window.__rafId = requestAnimationFrame(loop);
  };
  window.__rafId = requestAnimationFrame(loop);
});

const end = Date.now() + SECONDS * 1000;
let phase = 0;
while (Date.now() < end) {
  // Alternate 1s of orbit (left drag) and 1s of pan (right drag), sweeping in an ellipse.
  const button = phase % 2 === 0 ? 'left' : 'right';
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button });
  const segEnd = Math.min(end, Date.now() + 1000);
  let a = 0;
  while (Date.now() < segEnd) {
    a += 0.08;
    await page.mouse.move(cx + Math.cos(a) * 220, cy + Math.sin(a) * 120);
  }
  await page.mouse.up({ button });
  phase++;
}

const frames = await page.evaluate(() => {
  cancelAnimationFrame(window.__rafId);
  return window.__frames;
});
await browser.close();

const deltas = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
const pct = (p) => deltas[Math.min(deltas.length - 1, Math.floor((p / 100) * deltas.length))];
const elapsed = frames[frames.length - 1] - frames[0];
console.log(
  JSON.stringify(
    {
      url: URL,
      ...env,
      seconds: +(elapsed / 1000).toFixed(2),
      frames: frames.length,
      avgFps: +(((frames.length - 1) * 1000) / elapsed).toFixed(1),
      frameTimeMs: {
        p50: +pct(50).toFixed(2),
        p95: +pct(95).toFixed(2),
        p99: +pct(99).toFixed(2),
        max: +deltas[deltas.length - 1].toFixed(2),
      },
      framesOver20ms: deltas.filter((d) => d > 20).length,
    },
    null,
    2,
  ),
);
