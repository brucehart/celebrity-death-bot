import { escapeHtmlText, escapeHtmlAttr, buildTelegramMessage, truncateTelegramHTML, MAX_TELEGRAM_LEN } from '../src/services/telegram.ts';

console.log('escapeHtmlText:', escapeHtmlText('\u0001a<&>b\u0007'));
console.log('escapeHtmlAttr:', escapeHtmlAttr('"<&>&"'));

const msg = buildTelegramMessage({
  name: 'A&B <C>',
  age: 77,
  description: 'Rock & roll <legend>',
  cause: 'heart <failure> & complications',
  wiki_path: 'Test_(person)',
  link_type: 'active'
});
console.log('message:', msg);

const name = 'X'.repeat(50);
const m = `🚨💀<a href="https://en.wikipedia.org/wiki/Foo">${name}</a> : description 💀🚨`;
console.log('trunc:', truncateTelegramHTML(m, 40));

const longDesc = 'd'.repeat(5000);
const m2 = buildTelegramMessage({ name: 'Person', age: '99', description: longDesc, cause: '', wiki_path: 'Person', link_type: 'active' });
console.log('len:', m2.length, 'last:', m2.at(-1));

const m3 = buildTelegramMessage({ name: 'Test', age: 42, description: 'desc', cause: 'unknown', wiki_path: 'Test', link_type: 'active' });
console.log('hasCauseUnknown:', m3.includes(' - '));

const m4 = buildTelegramMessage({ name: 'Test', age: 42, description: 'desc', cause: 'Unknown', wiki_path: 'Test', link_type: 'active' });
console.log('hasCauseUnknown2:', m4.includes(' - '));
