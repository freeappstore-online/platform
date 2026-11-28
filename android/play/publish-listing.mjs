#!/usr/bin/env node
// Credentials are accepted on stdin only; never argv, disk or log output.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PlayRelease } from '../../scripts/android-play-release.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const command = process.argv[2] ?? 'inspect';
if (!['inspect', 'apply'].includes(command)) throw Error('Expected inspect or apply');
const client = new PlayRelease(JSON.parse(readFileSync(0, 'utf8')), {
  fetcher: async (...args) => {
    const response = await fetch(...args);
    if (!response.ok) {
      // Provider bodies may echo supplied data: emit only bounded reason enums and classifications.
      const body = await response
        .clone()
        .json()
        .catch(() => ({}));
      const message = String(body.error?.message ?? '').toLowerCase();
      const reasons = (body.error?.errors ?? [])
        .map((item) => item.reason)
        .filter((reason) => typeof reason === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(reason));
      const category = /invalidat|expired|deleted/.test(message)
        ? 'edit-invalidated-or-expired'
        : /permission|authoriz/.test(message)
          ? 'publisher-permission'
          : /review/.test(message)
            ? 'review-restriction'
            : /privacy|policy|declaration/.test(message)
              ? 'store-requirements'
              : 'unclassified-provider-rejection';
      console.error(JSON.stringify({ providerStatus: response.status, reasons, category }));
    }
    return response;
  },
});
const token = await client.token();
const types = [
  'icon',
  'featureGraphic',
  'phoneScreenshots',
  'sevenInchScreenshots',
  'tenInchScreenshots',
];
const locales = ['en-GB', 'en-US'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const request = (method, path, body) => client.request(token, method, path, body);
async function snapshot(id) {
  const listings = (await request('GET', `/edits/${id}/listings`)).listings ?? [];
  const images = {};
  for (const listing of listings) {
    images[listing.language] = {};
    for (const type of types)
      images[listing.language][type] =
        (await request('GET', `/edits/${id}/listings/${listing.language}/${type}`)).images ?? [];
  }
  return { listings, images };
}
function describe(state) {
  return {
    locales: state.listings.map(({ language, title, shortDescription, fullDescription }) => ({
      language,
      title,
      shortDescription,
      fullDescriptionCharacters: fullDescription?.length ?? 0,
    })),
    images: Object.fromEntries(
      Object.entries(state.images).map(([locale, types]) => [
        locale,
        Object.fromEntries(
          Object.entries(types).map(([type, images]) => [
            type,
            images.map(({ id, sha256 }) => ({ id, sha256 })),
          ]),
        ),
      ]),
    ),
  };
}
if (command === 'inspect') {
  await client.edit(token, async (id) =>
    console.log(JSON.stringify(describe(await snapshot(id)), null, 2)),
  );
} else {
  const manifest = JSON.parse(readFileSync(resolve(root, 'export-manifest.json'), 'utf8'));
  assert.equal(manifest.package, 'online.freeappstore.companion');
  const text = {
    language: '',
    title: readFileSync(resolve(root, 'en-US/title.txt'), 'utf8').trim(),
    shortDescription: readFileSync(resolve(root, 'en-US/short-description.txt'), 'utf8').trim(),
    fullDescription: readFileSync(resolve(root, 'en-US/full-description.txt'), 'utf8').trim(),
  };
  const images = manifest.assets
    .filter((x) => ['icon', 'featureGraphic', 'phoneScreenshot'].includes(x.kind))
    .map((x) => ({
      ...x,
      type: x.kind === 'phoneScreenshot' ? 'phoneScreenshots' : x.kind,
      bytes: readFileSync(resolve(root, x.file)),
    }));
  assert.ok(
    images.filter((x) => x.type === 'phoneScreenshots').length >= 2,
    'Reviewed screenshot set required',
  );
  for (const item of manifest.assets)
    assert.equal(
      hash(readFileSync(resolve(root, item.file))),
      item.sha256,
      `Review manifest differs: ${item.file}`,
    );
  let before;
  await client.edit(token, async (id) => {
    before = await snapshot(id);
    for (const locale of locales) {
      const current = before.listings.find((x) => x.language === locale);
      for (const key of ['title', 'shortDescription', 'fullDescription'])
        assert.ok(
          !current?.[key] || current[key] === text[key],
          `Existing ${locale} ${key} differs: review required, refusing overwrite`,
        );
      for (const type of ['icon', 'featureGraphic', 'phoneScreenshots']) {
        const existing = before.images[locale]?.[type] ?? [];
        const planned = images.filter((x) => x.type === type);
        assert.ok(
          existing.length === 0 ||
            (existing.length === planned.length &&
              existing.every((x, i) => x.sha256 === planned[i].sha256)),
          `Existing ${locale} ${type} differs: refusing deletion or replacement`,
        );
      }
    }
    for (const locale of locales) {
      await request('PUT', `/edits/${id}/listings/${locale}`, {
        ...before.listings.find((x) => x.language === locale),
        ...text,
        language: locale,
      });
      for (const image of images) {
        if ((before.images[locale]?.[image.type] ?? []).some((x) => x.sha256 === image.sha256))
          continue;
        const response = await fetch(
          `https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications/online.freeappstore.companion/edits/${id}/listings/${locale}/${image.type}?uploadType=media`,
          {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(120000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' },
            body: image.bytes,
          },
        );
        if (!response.ok)
          throw Error(`Play image upload ${locale}/${image.type}: HTTP ${response.status}`);
        const uploaded = await response.json();
        assert.equal(
          uploaded.image?.sha256,
          image.sha256,
          'Play image digest differs from reviewed bytes',
        );
      }
    }
    await request('POST', `/edits/${id}:validate`);
    await request(
      'POST',
      `/edits/${id}:commit${process.argv.includes('--defer-review') ? '?changesNotSentForReview=true' : ''}`,
    );
  });
  await client.edit(token, async (id) => {
    const actual = await snapshot(id);
    for (const locale of locales) {
      const listing = actual.listings.find((x) => x.language === locale);
      for (const key of ['title', 'shortDescription', 'fullDescription'])
        assert.equal(listing?.[key], text[key]);
      assert.equal(listing?.video, before.listings.find((x) => x.language === locale)?.video);
      for (const type of ['sevenInchScreenshots', 'tenInchScreenshots'])
        assert.deepEqual(actual.images[locale]?.[type] ?? [], before.images[locale]?.[type] ?? []);
      for (const type of ['icon', 'featureGraphic', 'phoneScreenshots'])
        assert.deepEqual(
          (actual.images[locale]?.[type] ?? []).map((x) => x.sha256),
          images.filter((x) => x.type === type).map((x) => x.sha256),
        );
    }
    for (const listing of before.listings.filter((x) => !locales.includes(x.language)))
      assert.deepEqual(
        actual.listings.find((x) => x.language === listing.language),
        listing,
      );
    console.log(
      JSON.stringify(
        {
          verified: true,
          locales,
          reviewStatus: 'API acceptance is not Google review approval',
          ...describe(actual),
        },
        null,
        2,
      ),
    );
  });
}
