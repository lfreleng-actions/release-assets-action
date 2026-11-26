// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Linux Foundation

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const uploadAssets = require('../scripts/upload-assets.js');

function createHarness(t, listReleases) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-assets-'));
  const assetPath = path.join(directory, 'asset.txt');
  fs.writeFileSync(assetPath, 'asset');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const failures = [];
  const logs = [];
  const delays = [];
  const core = {
    error() {},
    info: message => logs.push(message),
    setFailed: message => failures.push(message),
    warning() {},
    setOutput() {},
    summary: {
      addHeading() { return this; },
      addRaw() { return this; },
      addBreak() { return this; },
      addList() { return this; },
      write() { return this; }
    }
  };
  const github = {
    rest: {
      repos: {
        getReleaseByTag: async () => {
          throw { status: 404 };
        },
        listReleases,
        uploadReleaseAsset: async () => ({
          data: { browser_download_url: 'https://example.test/asset.txt' }
        })
      }
    }
  };

  return {
    delays,
    failures,
    logs,
    run: () => uploadAssets({
      github,
      context: { repo: { owner: 'owner', repo: 'repo' }, ref: 'refs/heads/main' },
      core,
      glob: { create: async () => ({ glob: async () => [assetPath] }) },
      assetPathsInput: '["asset.txt"]',
      releaseTag: 'v1.0.0',
      releaseName: '',
      sleep: async delay => delays.push(delay)
    })
  };
}

test('finds a release on the second search pass', async t => {
  let calls = 0;
  const pages = [];
  const harness = createHarness(t, async ({ page }) => {
    calls++;
    pages.push(page);
    return {
      data: calls === 1
        ? []
        : [{ id: 1, name: 'Release', tag_name: 'v1.0.0', assets: [] }]
    };
  });

  await harness.run();

  assert.equal(calls, 2);
  assert.deepEqual(pages, [1, 1]);
  assert.deepEqual(harness.delays, [1000]);
  assert.deepEqual(harness.failures, []);
  assert.ok(harness.logs.some(message => message.includes('retry 1/4 in 1 seconds')));
});

test('reports the existing not-found error after bounded retries', async t => {
  let calls = 0;
  const harness = createHarness(t, async () => {
    calls++;
    return { data: [] };
  });

  await harness.run();

  assert.equal(calls, 5);
  assert.deepEqual(harness.delays, [1000, 2000, 4000, 8000]);
  assert.deepEqual(harness.failures, ["No release found with tag 'v1.0.0'"]);
});

test('does not retry when listing releases fails', async t => {
  const error = new Error('API unavailable');
  let calls = 0;
  const harness = createHarness(t, async () => {
    calls++;
    throw error;
  });

  await assert.rejects(harness.run(), caught => caught === error);

  assert.equal(calls, 1);
  assert.deepEqual(harness.delays, []);
});
