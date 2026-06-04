'use strict';

const { chromium } = require('playwright');

const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-web-security',
  '--disable-site-isolation-trials',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--js-flags=--max-old-space-size=384',
  '--aggressive-cache-discard',
  '--disable-cache',
  '--disable-application-cache',
];

// Per-worker browser registry — keyed by workerId
const browsers = new Map();

async function getBrowser(workerId = 'default') {
  let b = browsers.get(workerId);
  if (!b || !b.isConnected()) {
    b = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    b.on('disconnected', () => browsers.delete(workerId));
    browsers.set(workerId, b);
  }
  return b;
}

async function closeBrowser(workerId = 'default') {
  const b = browsers.get(workerId);
  if (b) {
    try { await b.close(); } catch (_) {}
    browsers.delete(workerId);
  }
}

async function closeAllBrowsers() {
  for (const [id, b] of browsers) {
    try { await b.close(); } catch (_) {}
    browsers.delete(id);
  }
}

async function createContext(browser) {
  return browser.newContext({
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1200, height: 800 },
    javaScriptEnabled: true, // required for CSS-in-JS and layout-affecting scripts
  });
}

async function blockResources(page) {
  await page.route('**/*', async route => {
    const type = route.request().resourceType();
    const url  = route.request().url();
    // Allow document, stylesheet, script, font — block only tracking/analytics/media
    if (['image', 'media', 'websocket', 'eventsource'].includes(type)) return route.abort();
    const blocked = ['analytics', 'google-analytics', 'facebook', 'hotjar', 'segment', 'gtm', 'doubleclick'];
    if (blocked.some(p => url.includes(p))) return route.abort();
    return route.continue();
  });
}

module.exports = { getBrowser, closeBrowser, closeAllBrowsers, createContext, blockResources };
