'use strict';

/**
 * Security model:
 *
 * STRIDE coverage:
 *   Spoofing          — browser runs as unprivileged process; no credentials stored
 *   Tampering         — all network requests blocked except file:// and data:
 *   Info Disclosure   — bypassCSP removed; JS cannot read cross-origin data
 *   DoS               — JS heap capped; renderer restarted periodically
 *   Elevation         — --no-sandbox is required for Docker/CI; document below
 *
 * OWASP coverage:
 *   A01 Broken Access Control  — only file:// allowed; no internal HTTP access
 *   A03 Injection              — JS enabled for layout but all network blocked (SSRF prevention)
 *   A05 Misconfig              — --disable-web-security REMOVED; CSP enforced
 *   A10 SSRF                   — route handler blocks ALL non-file:// requests
 *
 * NOTE on --no-sandbox:
 *   Required in Docker (no user namespaces) and most CI environments.
 *   Risk: if Chromium is exploited via a malicious HTML payload, the attacker
 *   gains the process user's privileges (not root if running as non-root).
 *   Mitigation: run the server as a dedicated low-privilege user in production.
 */

const { chromium } = require('playwright');

const LAUNCH_ARGS = [
  '--disable-dev-shm-usage',
  '--no-sandbox',              // required for Docker — see note above
  '--disable-setuid-sandbox',
  '--disable-gpu',
  // REMOVED: --disable-web-security  (disabled SOP — critical SSRF / XSS risk)
  // REMOVED: --disable-site-isolation-trials (weakens renderer isolation)
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
  // Harden renderer process
  '--disable-features=NetworkService',  // force in-process network (easier to intercept)
  '--block-new-web-contents',           // prevent popups / new windows from HTML
];

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
    bypassCSP: false,             // FIXED: enforce Content-Security-Policy
    ignoreHTTPSErrors: false,     // FIXED: validate TLS (irrelevant for file://, safety default)
    javaScriptEnabled: true,      // needed for CSS-in-JS layout; network is blocked at route level
    viewport: { width: 1200, height: 800 },

    // Strict permission policy — deny all browser APIs that could leak data
    permissions: [],
    geolocation: undefined,
    extraHTTPHeaders: {},
  });
}

/**
 * SSRF Prevention — block ALL network requests from rendered pages.
 *
 * Only file:// and data: URIs are permitted.
 * This prevents uploaded HTML from using fetch()/XHR/CSS @import to:
 *   - probe internal services (169.254.169.254, localhost, etc.)
 *   - exfiltrate data to external servers
 *   - load attacker-controlled scripts
 */
async function blockResources(page) {
  await page.route('**/*', async route => {
    const url = route.request().url();

    // Allow only local file:// and inline data: URIs
    if (url.startsWith('file://') || url.startsWith('data:')) {
      return route.continue();
    }

    // Block everything else — http, https, ftp, ws, wss, blob pointing to remote
    return route.abort('blockedbyclient');
  });
}

module.exports = { getBrowser, closeBrowser, closeAllBrowsers, createContext, blockResources };
