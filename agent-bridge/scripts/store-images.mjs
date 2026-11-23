// Chrome Web Store images, into store/: the 128 px store icon (96 px mark,
// 16 px clear around it), a 440×280 promo tile, and 1280×800 screenshots made
// from the demo pages (options.html?demo, sidepanel.html?demo).
// Run with: bun run store:images (needs Playwright and its Chromium).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const EXT = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "store");
const MARK = fs.readFileSync(path.join(EXT, "icons", "eyepatch.svg"), "utf8");
const FONTS = `@font-face { font-family: Geist; src: url(/ui/fonts/Geist-Variable.woff2); font-weight: 100 900; }`;

// Serve extension/ (modules don't load from file://) plus the pages below.
const pages = {
  "/_icon.html": `<style>html,body{margin:0;background:transparent}</style><div style="width:128px;height:128px;display:grid;place-items:center">${MARK.replace('width="100" height="100"', 'width="96" height="96"')}</div>`,
  "/_promo.html": `<style>${FONTS} html,body{margin:0} body{width:440px;height:280px;background:#F4F4F2;display:flex;align-items:center;justify-content:center;gap:22px;font-family:Geist,sans-serif;color:#19191B}
    h1{font-size:44px;font-weight:600;margin:0;letter-spacing:-0.02em} p{margin:6px 0 0;font-size:16px;color:#5C5C61;max-width:220px;line-height:1.35}</style>
    ${MARK.replace('width="100" height="100"', 'width="104" height="104"')}<div><h1>Eyepatch</h1><p>Change any website by chatting with a coding agent.</p></div>`,
  // A plain article with the side panel beside it, as Chrome shows it.
  "/_panel.html": `<style>${FONTS} html,body{margin:0;height:100%} body{display:flex;font-family:Geist,sans-serif;background:#fff;color:#19191B}
    .page{flex:1;padding:72px 96px;overflow:hidden} .page h1{font-size:40px;font-weight:600;margin:0 0 8px;letter-spacing:-0.02em} .meta{color:#737378;margin-bottom:32px}
    .page p{font-size:18px;line-height:1.7;color:#333;max-width:620px} nav{display:flex;gap:24px;margin-bottom:56px;color:#5C5C61;font-size:15px}
    iframe{width:400px;border:0;border-left:1px solid #E4E4E2;height:100%}</style>
    <div class="page"><nav><b style="color:#19191B">The Daily Read</b><span>World</span><span>Tech</span><span>Culture</span></nav>
    <h1>How small tools change big habits</h1><div class="meta">8 min read</div>
    <p>Most of what we do on the web happens on sites we didn't build and can't change. The buttons are where someone else put them, the text is as wide as someone else decided, and the parts we never use are always there.</p>
    <p>Userscripts have always been the way out: a few lines that run on a site and make it yours. Writing them takes knowing the page's structure, its quirks, and some JavaScript.</p>
    <p>Asking for the change in plain words, and having an agent read the page and write the script, makes that available to anyone.</p></div>
    <iframe src="/sidepanel.html?demo"></iframe>`,
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (pages[p]) return new Response(pages[p], { headers: { "content-type": "text/html" } });
    const file = path.join(EXT, path.normalize(p));
    return file.startsWith(EXT) && fs.existsSync(file) ? new Response(Bun.file(file)) : new Response("", { status: 404 });
  },
});
const url = (p) => `http://127.0.0.1:${server.port}${p}`;

const browser = await chromium.launch();
async function shot(page, file, { width, height, omitBackground = false }) {
  const p = await browser.newPage({ viewport: { width, height }, colorScheme: "light" });
  await p.goto(url(page));
  await p.waitForTimeout(1200);
  await p.screenshot({ path: path.join(OUT, file), omitBackground });
  await p.close();
  console.log(`store/${file}`);
}

fs.mkdirSync(OUT, { recursive: true });
await shot("/_icon.html", "store-icon-128.png", { width: 128, height: 128, omitBackground: true });
await shot("/_promo.html", "promo-small-440x280.png", { width: 440, height: 280 });
await shot("/_panel.html", "screenshot-1.png", { width: 1280, height: 800 });
await shot("/options.html?demo", "screenshot-2.png", { width: 1280, height: 800 });
await browser.close();
server.stop(true);
