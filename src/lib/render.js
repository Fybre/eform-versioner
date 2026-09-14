'use strict';

const http = require('http');
const { decodeToJson } = require('./formCodec');

let puppeteerModule = null;
let puppeteerLoadError = null;
try {
  // Optional dependency — screenshot rendering degrades gracefully if it's not installed.
  puppeteerModule = require('puppeteer');
} catch (err) {
  puppeteerLoadError = err;
}

function escapeForScriptTag(jsonString) {
  return jsonString.replace(/<\/script/gi, '<\\/script');
}

function buildHtml(formSchema) {
  const schemaJson = escapeForScriptTag(JSON.stringify(formSchema));
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/formiojs@4.21.7/dist/formio.full.min.css" />
<style>
  body { margin: 0; padding: 24px; background: #ffffff; font-family: -apple-system, Helvetica, Arial, sans-serif; }
  #formio { max-width: 760px; }
</style>
</head>
<body>
<div id="formio"></div>
<script src="https://cdn.jsdelivr.net/npm/formiojs@4.21.7/dist/formio.full.min.js"></script>
<script>
  window.__renderState = 'pending';
  var schema = ${schemaJson};
  Formio.createForm(document.getElementById('formio'), schema, { readOnly: true })
    .then(function () { window.__renderState = 'done'; })
    .catch(function (err) {
      window.__renderState = 'error';
      window.__renderError = String(err);
    });
</script>
</body>
</html>`;
}

/**
 * Puppeteer's page.setContent() leaves the page on an opaque "about:blank" origin, which
 * some Chromium builds block cross-origin script/style loads from (ORB) — formio.js from the
 * CDN then silently never loads and the render hangs until timeout. Serving the HTML from a
 * real (if ephemeral, localhost-only) HTTP origin and navigating to it avoids that.
 */
function serveHtmlOnce(html) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
    server.on('error', reject);
  });
}

/**
 * Renders a form.io schema (base64-encoded FormDefinition, or already-decoded object) to a
 * PNG screenshot using a headless browser. Returns { ok:false, reason } if puppeteer isn't
 * available or rendering fails/times out — callers should treat that as "screenshot
 * unavailable", not a hard error, since this is a nice-to-have visual aid, not core functionality.
 */
async function renderFormScreenshot(formDefinitionB64OrObj, { timeoutMs = 20000 } = {}) {
  if (!puppeteerModule) {
    return { ok: false, reason: `puppeteer not installed: ${puppeteerLoadError && puppeteerLoadError.message}` };
  }
  const schema = (typeof formDefinitionB64OrObj === 'object' && formDefinitionB64OrObj) || decodeToJson(formDefinitionB64OrObj);
  if (!schema) return { ok: false, reason: 'Could not decode form definition' };

  let browser;
  let htmlServer;
  try {
    htmlServer = await serveHtmlOnce(buildHtml(schema));
    browser = await puppeteerModule.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 820, height: 1000 });
    await page.goto(htmlServer.url, { waitUntil: 'load', timeout: timeoutMs });
    await page.waitForFunction(
      () => window.__renderState === 'done' || window.__renderState === 'error',
      { timeout: timeoutMs }
    );
    const state = await page.evaluate(() => window.__renderState);
    if (state === 'error') {
      const err = await page.evaluate(() => window.__renderError);
      return { ok: false, reason: `Form.io render error: ${err}` };
    }
    // Let async component rendering (e.g. select widgets) settle a moment.
    await new Promise((r) => setTimeout(r, 400));
    const el = await page.$('#formio');
    const buffer = await (el || page).screenshot({ type: 'png' });
    return { ok: true, buffer };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (htmlServer) htmlServer.close();
  }
}

module.exports = { renderFormScreenshot, isAvailable: () => !!puppeteerModule };
