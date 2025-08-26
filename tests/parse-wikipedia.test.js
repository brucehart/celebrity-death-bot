import test from 'node:test';
import assert from 'node:assert/strict';

import { parseWikipedia } from '../src/services/wiki.ts';

const sample = `
<ul>
  <li><a href="/wiki/Jane_Doe">Jane Doe</a>, 88, American actor and philanthropist.</li>
  <li><a href="/wiki/John_Smith">John Smith</a>, 54, English footballer, cancer.</li>
  <li>Not a match</li>
</ul>`;

test('parseWikipedia extracts name, wiki_path, age, description', () => {
  const rows = parseWikipedia(sample);
  assert.equal(rows.length, 2);

  assert.deepEqual(rows[0], {
    name: 'Jane Doe',
    wiki_path: 'Jane_Doe',
    link_type: 'active',
    age: 88,
    description: 'American actor and philanthropist',
    cause: null,
  });

  assert.deepEqual(rows[1], {
    name: 'John Smith',
    wiki_path: 'John_Smith',
    link_type: 'active',
    age: 54,
    description: 'English footballer, cancer',
    cause: null,
  });
});
