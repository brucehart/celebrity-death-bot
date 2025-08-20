import test from 'node:test';
import assert from 'node:assert/strict';

import {
  escapeHtmlText,
  escapeHtmlAttr,
  buildTelegramMessage,
  truncateTelegramHTML,
  MAX_TELEGRAM_LEN,
} from '../src/services/telegram.ts';

test('escapeHtmlText escapes &, <, > and strips control chars', () => {
  const input = '\u0001a<&>b\u0007';
  const out = escapeHtmlText(input);
  assert.equal(out, 'a&lt;&amp;&gt;b');
});

test('escapeHtmlAttr escapes quotes and specials', () => {
  const input = '"<&>&"';
  const out = escapeHtmlAttr(input);
  assert.equal(out, '&quot;&lt;&amp;&gt;&amp;&quot;');
});

test('buildTelegramMessage wraps name in safe link and escapes fields', () => {
  const msg = buildTelegramMessage({
    name: 'A&B <C>',
    age: 77,
    description: 'Rock & roll <legend>',
    cause: 'heart <failure> & complications',
    wiki_path: '/wiki/Test_(person)'
  });
  assert.match(msg, /^🚨💀<a href=\"https:\/\/www\.wikipedia\.org\/[^"]+\">A&amp;B &lt;C&gt;<\/a> \(77\) : Rock &amp; roll &lt;legend&gt; - heart &lt;failure&gt; &amp; complications💀🚨$/);
  assert.ok(msg.length <= MAX_TELEGRAM_LEN);
});

test('truncateTelegramHTML does not break the <a> tag when cutting early', () => {
  const name = 'X'.repeat(50);
  const msg = `🚨💀<a href="https://www.wikipedia.org/wiki/Foo">${name}</a> : description 💀🚨`;
  const truncated = truncateTelegramHTML(msg, 40);
  // if cut within anchor, function should keep full </a> and add ellipsis
  assert.match(truncated, /<\/a>…$/);
  assert.ok(truncated.length <= 40);
});

test('buildTelegramMessage enforces 4096 character limit with ellipsis', () => {
  const longDesc = 'd'.repeat(5000);
  const msg = buildTelegramMessage({ name: 'Person', age: '99', description: longDesc, cause: '', wiki_path: '/wiki/Person' });
  assert.ok(msg.length <= MAX_TELEGRAM_LEN);
  assert.equal(msg.at(-1), '…');
});
