/**
 * The pinned-IP undici dispatcher, written once for every SSRF-safe fetcher
 * (`safe-fetch-html.mjs`, `safe-fetch-binary.mjs`, markdownify's `safeFetch`).
 *
 * Why pin: the caller has already resolved the hostname and refused a private
 * answer (`resolveAndAssertPublic`). If the connector were allowed to resolve
 * again, a DNS server flipping its answer between the two lookups (DNS
 * rebinding) would send the request to an internal address. The dispatcher's
 * `connect.lookup` therefore ignores the host and always answers with the
 * address that was validated.
 *
 * Why one copy: Node calls a custom lookup in two forms. Since Node 20,
 * `net.connect` enables `autoSelectFamily` by default and calls it with
 * `opts.all === true`, expecting ONE array argument of `{ address, family }`
 * records; with `autoSelectFamily` off it expects the scalar
 * `(err, address, family)`. Answering the scalar form to an `all` call makes
 * undici fail before connecting with `ERR_INVALID_IP_ADDRESS: Invalid IP
 * address: undefined`. The two `safe-fetch-*` helpers were fixed for this in
 * v0.13.5; markdownify's `safeFetch` kept its own scalar copy and broke
 * `webpage_to_markdown` and every `convertUrl` caller on every site, until
 * 2026-10-11. A test in `tests/markdownify.test.mjs` now refuses any
 * `lookup:` in `src/` outside this file.
 */
import { Agent } from 'undici';

/**
 * A `connect.lookup` that always answers `address`/`family`, whatever host it
 * is asked about, in whichever calling convention Node uses.
 *
 * @param {string} address — the validated IP
 * @param {4|6} family
 * @returns {(host: string, opts: object|undefined, cb: Function) => void}
 */
export function pinnedLookup(address, family) {
  return (_host, opts, cb) => {
    if (opts && opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

/**
 * An undici `Agent` whose every connection goes to `address`. The caller owns
 * it and should `close()` it when done, so the socket pool is released
 * without waiting for GC.
 *
 * @param {{ address: string, family: 4|6 }} pin
 * @returns {Agent}
 */
export function createPinnedAgent({ address, family }) {
  return new Agent({ connect: { lookup: pinnedLookup(address, family) } });
}
