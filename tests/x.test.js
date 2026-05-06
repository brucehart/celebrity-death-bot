import test from 'node:test';
import assert from 'node:assert/strict';

import { buildXStatus, postToXIfConfigured, shouldIncludeWikipediaLinkInXPost, shouldPostToX } from '../src/services/x.ts';

const postInput = {
  name: 'Jane Doe',
  age: 88,
  description: 'American actor',
  cause: 'unknown',
  wiki_path: 'Jane_Doe',
  link_type: 'active',
};

test('X posting flags default to false', () => {
  assert.equal(shouldPostToX({}), false);
  assert.equal(shouldIncludeWikipediaLinkInXPost({}), false);
});

test('X posting flags accept explicit true values', () => {
  assert.equal(shouldPostToX({ POST_TO_X: 'true' }), true);
  assert.equal(shouldPostToX({ POST_TO_X: '1' }), true);
  assert.equal(shouldIncludeWikipediaLinkInXPost({ X_POST_INCLUDE_WIKIPEDIA_LINK: 'yes' }), true);
  assert.equal(shouldIncludeWikipediaLinkInXPost({ X_POST_INCLUDE_WIKIPEDIA_LINK: 'on' }), true);
});

test('buildXStatus omits Wikipedia link unless requested', () => {
  const text = buildXStatus(postInput);
  assert.ok(!text.includes('https://en.wikipedia.org/wiki/Jane_Doe'));
});

test('buildXStatus includes Wikipedia link when requested', () => {
  const text = buildXStatus(postInput, { includeWikipediaLink: true });
  assert.ok(text.includes('https://en.wikipedia.org/wiki/Jane_Doe'));
});

test('postToXIfConfigured returns before network work when disabled', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('fetch should not be called');
  };
  try {
    await postToXIfConfigured({}, 'test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
