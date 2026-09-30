/**
 * plugin-release-resolver — the network half of `--install-plugins`, driven
 * entirely through a fake transport (tests/fixtures/plugin-github-fake.mjs).
 * Nothing here reaches the network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_HOSTS,
  REGISTRY_URL,
  assertAllowedUrl,
  createGuardedFetch,
  fetchRegistry,
  resolveLatestRelease,
  selectPluginAssets,
  downloadAsset,
  verifyManifest,
  verifyMainJs,
  repoFromGithubUrl,
} from '../src/helpers/plugin-release-resolver.mjs';
import { fakeGitHub, standardFleet, releaseRoutes, manifestOf, REGISTRY_URL as FIXTURE_REGISTRY_URL } from './fixtures/plugin-github-fake.mjs';

describe('host allowlist — every request AND every redirect hop', () => {
  test('the registry URL the resolver uses is the official one', () => {
    assert.equal(REGISTRY_URL, FIXTURE_REGISTRY_URL);
  });

  test('allowed GitHub hosts pass; http, foreign hosts, ports and credentials are refused', () => {
    for (const h of GITHUB_HOSTS) assert.ok(assertAllowedUrl(`https://${h}/x`));
    assert.throws(() => assertAllowedUrl('http://github.com/x'), { code: 'not_https' });
    assert.throws(() => assertAllowedUrl('https://evil.example/x'), { code: 'host_not_allowed' });
    assert.throws(() => assertAllowedUrl('https://github.com.evil.example/x'), { code: 'host_not_allowed' });
    assert.throws(() => assertAllowedUrl('https://github.com:8443/x'), { code: 'bad_port' });
    assert.throws(() => assertAllowedUrl('https://user:pw@github.com/x'), { code: 'credentials_in_url' });
    assert.throws(() => assertAllowedUrl('https://codeload.github.com/x'), { code: 'host_not_allowed' });
  });

  test('a redirect to a foreign host is refused, and the foreign host is never requested', async () => {
    const gh = fakeGitHub({
      'https://github.com/o/r/releases/download/v1/main.js': { status: 302, headers: { location: 'https://cdn.evil.example/main.js' } },
      'https://cdn.evil.example/main.js': { status: 200, body: 'pwned' },
    });
    const fetch = createGuardedFetch({ transport: gh.transport });
    await assert.rejects(fetch('https://github.com/o/r/releases/download/v1/main.js'), { code: 'host_not_allowed' });
    assert.deepEqual(gh.calls, ['https://github.com/o/r/releases/download/v1/main.js']);
  });

  test('a redirect down to http is refused', async () => {
    const gh = fakeGitHub({
      'https://github.com/a': { status: 301, headers: { location: 'http://objects.githubusercontent.com/a' } },
    });
    const fetch = createGuardedFetch({ transport: gh.transport });
    await assert.rejects(fetch('https://github.com/a'), { code: 'not_https' });
    assert.equal(gh.calls.length, 1);
  });

  test('redirects are bounded', async () => {
    const gh = fakeGitHub({
      'https://github.com/a': { status: 302, headers: { location: '/b' } },
      'https://github.com/b': { status: 302, headers: { location: '/a' } },
    });
    const fetch = createGuardedFetch({ transport: gh.transport, maxRedirects: 3 });
    await assert.rejects(fetch('https://github.com/a'), { code: 'too_many_redirects' });
  });

  test('a body over the cap is refused, not truncated', async () => {
    const gh = fakeGitHub({ 'https://github.com/big': { status: 200, body: Buffer.alloc(100) } });
    const fetch = createGuardedFetch({ transport: gh.transport });
    await assert.rejects(fetch('https://github.com/big', { maxBytes: 99 }), { code: 'too_large' });
  });
});

describe('registry → release resolution', () => {
  test('a moved repository: the API redirect is followed and the FINAL repo is recorded', async () => {
    const gh = fakeGitHub(standardFleet());
    const fetch = createGuardedFetch({ transport: gh.transport });
    const registry = await fetchRegistry(fetch);
    assert.equal(registry.get('obsidian-style-settings'), 'old-owner/obsidian-style-settings');
    const rel = await resolveLatestRelease(fetch, registry.get('obsidian-style-settings'));
    assert.equal(rel.requestedRepo, 'old-owner/obsidian-style-settings');
    assert.equal(rel.resolvedRepo, 'community-archive/obsidian-style-settings');
    assert.equal(rel.redirected, true);
    assert.equal(rel.tag, '1.0.9');
    assert.ok(gh.calls.includes('https://api.github.com/repositories/424242/releases/latest'));
  });

  test('an unmoved repository is not reported as redirected', async () => {
    const gh = fakeGitHub(standardFleet());
    const fetch = createGuardedFetch({ transport: gh.transport });
    const rel = await resolveLatestRelease(fetch, 'tmpl-owner/Templater');
    assert.equal(rel.redirected, false);
    assert.equal(rel.resolvedRepo, 'tmpl-owner/Templater');
  });

  test('assets: main.js + manifest.json required, styles.css optional, and each follows its CDN redirect', async () => {
    const gh = fakeGitHub(standardFleet());
    const fetch = createGuardedFetch({ transport: gh.transport });
    const rel = await resolveLatestRelease(fetch, 'tmpl-owner/Templater');
    const assets = selectPluginAssets(rel);
    assert.deepEqual(assets.map((a) => a.name), ['main.js', 'manifest.json']);
    const buf = await downloadAsset(fetch, assets[0]);
    assert.match(buf.toString(), /templater 2\.3\.0/);
    assert.ok(gh.calls.some((u) => u.startsWith('https://release-assets.githubusercontent.com/')));
  });

  test('a release without main.js is refused', () => {
    assert.throws(
      () => selectPluginAssets({ resolvedRepo: 'o/r', tag: 'v1', assets: [{ name: 'manifest.json', size: 1, id: 1, url: 'https://github.com/o/r/releases/download/v1/manifest.json' }] }),
      { code: 'missing_asset' },
    );
  });

  test('an asset URL that points outside the release repository is refused', () => {
    assert.throws(
      () => selectPluginAssets({
        resolvedRepo: 'o/r', tag: 'v1',
        assets: [
          { name: 'main.js', size: 1, id: 1, url: 'https://github.com/someone-else/r/releases/download/v1/main.js' },
          { name: 'manifest.json', size: 1, id: 2, url: 'https://github.com/o/r/releases/download/v1/manifest.json' },
        ],
      }),
      { code: 'foreign_asset_url' },
    );
  });

  test('a download whose size differs from the declared one is refused', async () => {
    const routes = releaseRoutes({ repo: 'o/r', tag: 'v1', files: { 'main.js': 'abc', 'manifest.json': manifestOf('x', '1') } });
    const gh = fakeGitHub(routes);
    const fetch = createGuardedFetch({ transport: gh.transport });
    const rel = await resolveLatestRelease(fetch, 'o/r');
    const [main] = selectPluginAssets(rel);
    await assert.rejects(downloadAsset(fetch, { ...main, size: main.size + 1 }), { code: 'size_mismatch' });
  });
});

describe('verification', () => {
  test('manifest id mismatch is refused', () => {
    assert.throws(() => verifyManifest(Buffer.from(JSON.stringify(manifestOf('other-plugin', '1.0.0'))), 'templater-obsidian'), { code: 'manifest_id_mismatch' });
  });
  test('a manifest without a version, or an HTML page, is refused', () => {
    assert.throws(() => verifyManifest(Buffer.from('{"id":"a"}'), 'a'), { code: 'bad_manifest' });
    assert.throws(() => verifyManifest(Buffer.from('<!DOCTYPE html><html>'), 'a'), { code: 'bad_manifest' });
    assert.equal(verifyManifest(Buffer.from(JSON.stringify(manifestOf('a', '1.2.3'))), 'a').version, '1.2.3');
  });
  test('main.js empty or HTML is refused', () => {
    assert.throws(() => verifyMainJs(Buffer.alloc(0), 'a'), { code: 'bad_main_js' });
    assert.throws(() => verifyMainJs(Buffer.from('  <html><body>404'), 'a'), { code: 'bad_main_js' });
    verifyMainJs(Buffer.from('module.exports={}'), 'a');
  });
  test('the bridge repo is read from its release-download URL', () => {
    assert.equal(repoFromGithubUrl('https://github.com/o/r/releases/latest/download/main.js'), 'o/r');
    assert.equal(repoFromGithubUrl('http://github.com/o/r/x'), null);
    assert.equal(repoFromGithubUrl('https://evil.example/o/r'), null);
  });
});
