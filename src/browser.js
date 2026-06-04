'use strict';

const { chromium } = require('playwright');

const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--single-process',
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  '--disable-site-isolation-trials',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
];

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  }
  return browserInstance;
}

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

async function createContext(browser) {
  return browser.newContext({
    bypassCSP: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1200, height: 800 },
  });
}

async function blockResources(page) {
  await page.route('**/*', async route => {
    const url = route.request().url();
    const type = route.request().resourceType();

    const blockedTypes = ['image', 'media'];
    const blockedPatterns = ['analytics', 'tracking', 'google-analytics', 'facebook', 'hotjar', 'segment'];
    const blockedExtensions = ['.woff', '.woff2', '.ttf', '.otf', '.eot'];

    if (blockedTypes.includes(type)) return route.abort();
    if (blockedPatterns.some(p => url.includes(p))) return route.abort();
    if (blockedExtensions.some(ext => url.split('?')[0].endsWith(ext))) return route.abort();

    return route.continue();
  });
}

module.exports = { getBrowser, closeBrowser, createContext, blockResources };
