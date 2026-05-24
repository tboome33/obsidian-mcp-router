/**
 * SSRF-safe HTML fetcher with pinned-IP undici dispatcher + manual
 * redirect handling + body-size cap + timeout. Extracted from
 * `src/tools/extract-page-metadata.mjs` and
 * `src/tools/propose-linked-sources.mjs` (both v0.13.2/v0.13.3 had
 * near-identical local implementations — the v0.13.4 review+ flagged
 * the duplication AND a P1 SSRF TOCTOU gap in the simpler pre-helper
 * versions of those tools).
 *
 * Why "pinned" matters (the bug this closes):
 *   The simpler pattern was:
 *     1. `validateUrl(url)`               — sync, refuses textual private IPs
 *     2. `await assertHostnameNotPrivate` — async DNS lookup, refuses private
 *     3. `await request(url)`              — undici re-does getaddrinfo
 *
 *   Between steps 2 and 3, a hostile DNS server can flip its answer
 *   (DNS rebinding) — `assertHostnameNotPrivate` saw a public IP, but
 *   undici's connect-time getaddrinfo gets a private IP. The fetch
 *   reaches an internal service.
 *
 *   The fix is to PIN the IP that step 2 validated: build a custom
 *   undici `Agent` whose `connect.lookup` always returns the resolved
 *   `{address, family}` ignoring `host`. The connector cannot re-resolve.
 *   Pattern stolen from `src/markdownify/markitdown.mjs:248` (`safeFetch`)
 *   which has carried this exact mitigation since v0.11.1 (bug_018 of the
 *   /ultrareview pass on v0.11.0).
 *
 * Per-hop re-pin: the redirect loop re-validates AND re-pins on every
 * hop, so an `evil.com → http://attacker.com → http://10.0.0.1/admin`
 * chain still gets refused at the final hop.
 *
 * @param {string} url — initial URL to fetch
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10_000]
 * @param {number} [opts.maxBytes=5*1024*1024]  — body size cap
 * @param {number} [opts.maxRedirects=5]
 * @param {string} [opts.userAgent]             — defaults to PKG_VERSION-derived
 * @param {string} [opts.accept='text/html,application/xhtml+xml']
 * @returns {Promise<{html: string, finalUrl: string}>}
 *          `finalUrl` is the post-redirect canonical URL (useful for
 *          downstream same-domain scoring like in link-extractor).
 */

import { Agent, request } from 'undici';
import { USER_AGENT } from './pkg-version.mjs';
import { validateUrl, resolveAndAssertPublic } from '../markdownify/utils.mjs';

export async function safeFetchHtml(url, opts = {}) {
  const {
    timeoutMs = 10_000,
    maxBytes = 5 * 1024 * 1024,
    maxRedirects = 5,
    userAgent = USER_AGENT,
    accept = 'text/html,application/xhtml+xml',
  } = opts;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    // Stage 1 — sync scheme + textual private-IP check.
    validateUrl(current);

    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`safe-fetch-html: invalid URL: ${current}`);
    }

    // Stage 2 — DNS resolve, refuse private, GET BACK THE RESOLVED IP.
    const { address, family } = await resolveAndAssertPublic(parsed.hostname);

    // Stage 3 — build a custom undici Agent that PINS the connect target
    // to the IP we just validated. undici's connector calls `lookup(host,
    // opts, cb)`; our lookup always callbacks with the pre-resolved
    // `{address, family}`, ignoring `host`. The connector cannot re-resolve
    // to a different (private) IP.
    const dispatcher = new Agent({
      connect: {
        lookup: (_host, _opts, cb) => cb(null, address, family),
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { statusCode, headers, body: respBody } = await request(current, {
        dispatcher,
        method: 'GET',
        headers: { 'user-agent': userAgent, accept },
        signal: controller.signal,
        maxRedirections: 0, // we handle redirects manually per-hop re-SSRF
      });

      // 3xx with Location → follow manually after re-validating the target.
      if (statusCode >= 300 && statusCode < 400) {
        const location = headers.location || headers.Location;
        if (!location) {
          throw new Error(`safe-fetch-html: HTTP ${statusCode} without Location header`);
        }
        // Drain body so undici can release the socket cleanly.
        try { for await (const _ of respBody) { /* discard */ } } catch { /* ignore */ }
        // Resolve relative redirect targets against the current URL.
        current = new URL(location, current).href;
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`safe-fetch-html: HTTP ${statusCode} from ${current}`);
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of respBody) {
        total += chunk.length;
        if (total > maxBytes) {
          throw new Error(`safe-fetch-html: response exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }
      return {
        html: Buffer.concat(chunks).toString('utf-8'),
        finalUrl: current,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`safe-fetch-html: too many redirects (>${maxRedirects}) starting from ${url}`);
}
