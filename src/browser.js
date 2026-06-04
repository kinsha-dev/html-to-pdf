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
  '--js-flags=--max-old-space-size=512',
  '--aggressive-cache-discard',
  '--disable-cache',
  '--disable-application-cache',
];

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
    browserInstance.on('disconnected', () => { browserInstance = null; });
  }
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (_) {}
    browserInstance = null;
  }
}

// Create a reusable context (caller manages lifetime)
async function createContext(browser) {
  return browser.newContext({
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1200, height: 800 },
    javaScriptEnabled: false,
  });
}

async function blockResources(page) {
  await page.route('**/*', async route => {
    const type = route.request().resourceType();
    const url = route.request().url();
    if (!['document', 'stylesheet'].includes(type)) return route.abort();
    const blocked = ['analytics', 'tracking', 'google-analytics', 'facebook', 'hotjar', 'segment', 'gtm'];
    if (blocked.some(p => url.includes(p))) return route.abort();
    return route.continue();
  });
}

module.exports = { getBrowser, closeBrowser, createContext, blockResources };
