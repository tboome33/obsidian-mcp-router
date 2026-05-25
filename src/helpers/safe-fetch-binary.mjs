/**
 * SSRF-safe binary fetcher — sibling of `safe-fetch-html.mjs` with the
 * same pinned-IP dispatcher + manual redirect re-SSRF + body-size cap +
 * timeout, but returns a Buffer + Content-Type instead of a UTF-8 string.
 *
 * Why a sibling instead of generalizing `safe-fetch-html.mjs`:
 *   The two callers have meaningfully different defaults — HTML expects
 *   `accept: text/html`, max 5 MiB, and decodes UTF-8 by default; binary
 *   wants `accept: image/*`, max 10 MiB per asset (images can be larger
 *   than HTML pages), and returns the raw Buffer + advertised
 *   Content-Type for the caller to pick a file extension. Folding both
 *   into one function would either require awkward `decodeAs: 'utf8' |
 *   'buffer'` parameters or leak HTML-specific defaults into binary calls.
 *
 *   The duplication is acknowledged: a future refactor could extract a
 *   private `_safeFetchCore({ ..., onChunk })` that both wrap. Phase E
 *   ships the simpler copy-paste path to keep the scope tight.
 *
 * SSRF mitigations (same as safe-fetch-html v0.13.5+):
 *   - validateUrl: refuses non-http(s) + textual private IPs
 *   - resolveAndAssertPublic: DNS-resolves and refuses private targets
 *   - pinned undici Agent: connector cannot re-resolve to a private IP
 *   - per-hop re-pin: redirect chain re-validates AND re-pins each hop
 *   - dual-form lookup callback: handles Node 20+ `autoSelectFamily`
 *     happy-eyeballs path (`opts.all=true` → array) + legacy scalar form
 *   - per-hop dispatcher cleanup to release socket pool deterministically
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=15_000]            — longer than HTML default; images can be slower
 * @param {number} [opts.maxBytes=10*1024*1024]       — per-asset cap (10 MiB)
 * @param {number} [opts.maxRedirects=5]
 * @param {string} [opts.userAgent]                   — defaults to PKG_VERSION-derived
 * @param {string} [opts.accept='image/*']
 * @returns {Promise<{
 *   buffer: Buffer,
 *   contentType: string,                              — raw header value, lowercased; may be 'application/octet-stream' if missing
 *   finalUrl: string,                                 — post-redirect URL
 * }>}
 */

import { Agent, request } from 'undici';
import { USER_AGENT } from './pkg-version.mjs';
import { validateUrl, resolveAndAssertPublic } from '../markdownify/utils.mjs';

export async function safeFetchBinary(url, opts = {}) {
  const {
    timeoutMs = 15_000,
    maxBytes = 10 * 1024 * 1024,
    maxRedirects = 5,
    userAgent = USER_AGENT,
    accept = 'image/*',
  } = opts;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    validateUrl(current);

    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      throw new Error(`safe-fetch-binary: invalid URL: ${current}`);
    }

    const { address, family } = await resolveAndAssertPublic(parsed.hostname);

    const dispatcher = new Agent({
      connect: {
        lookup: (_host, opts2, cb) => {
          // Dual-form callback — Node 20+ autoSelectFamily passes
          // opts.all=true and expects an array; legacy expects scalars.
          if (opts2 && opts2.all) {
            cb(null, [{ address, family }]);
          } else {
            cb(null, address, family);
          }
        },
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
        maxRedirections: 0,
      });

      if (statusCode >= 300 && statusCode < 400) {
        const location = headers.location || headers.Location;
        if (!location) {
          throw new Error(`safe-fetch-binary: HTTP ${statusCode} without Location header`);
        }
        try { for await (const _ of respBody) { /* discard */ } } catch { /* ignore */ }
        current = new URL(location, current).href;
        continue;
      }

      if (statusCode < 200 || statusCode >= 300) {
        throw new Error(`safe-fetch-binary: HTTP ${statusCode} from ${current}`);
      }

      const chunks = [];
      let total = 0;
      for await (const chunk of respBody) {
        total += chunk.length;
        if (total > maxBytes) {
          throw new Error(`safe-fetch-binary: response exceeds ${maxBytes} bytes`);
        }
        chunks.push(chunk);
      }

      const ctRaw = headers['content-type'] || headers['Content-Type'] || 'application/octet-stream';
      const contentType = String(Array.isArray(ctRaw) ? ctRaw[0] : ctRaw).toLowerCase().split(';')[0].trim();

      return {
        buffer: Buffer.concat(chunks),
        contentType,
        finalUrl: current,
      };
    } finally {
      clearTimeout(timer);
      try { await dispatcher.close(); } catch { /* ignore */ }
    }
  }

  throw new Error(`safe-fetch-binary: too many redirects (>${maxRedirects}) starting from ${url}`);
}
