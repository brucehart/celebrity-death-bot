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

test('parseWikipedia handles protocol-relative Wikipedia links', () => {
	const rows = parseWikipedia(`
    <ul>
      <li id="mwEw"><a rel="mw:WikiLink" href="//en.wikipedia.org/wiki/Alan_Banks_(footballer)" title="Alan Banks (footballer)">Alan Banks</a>, 87, English footballer.</li>
      <li id="mwHA"><a rel="mw:WikiLink" href="//en.wikipedia.org/wiki/Ciprian_Dumbrav%C4%83?action=edit&amp;redlink=1" class="new">Ciprian Dumbravă</a>, 76, Romanian footballer.</li>
    </ul>
  `);

	assert.equal(rows.length, 2);
	assert.equal(rows[0].wiki_path, 'Alan_Banks_(footballer)');
	assert.equal(rows[0].link_type, 'active');
	assert.equal(rows[1].wiki_path, 'Ciprian_Dumbrav%C4%83');
	assert.equal(rows[1].link_type, 'edit');
});

test('parseWikipedia can scope annual pages to the requested month section', () => {
	const annualSample = `
    <section><div class="mw-heading mw-heading2"><h2 id="July">July</h2></div>
      <section><h3 id="3">3</h3><ul>
        <li id="july-person"><a href="//en.wikipedia.org/wiki/July_Person">July Person</a>, 91, American actor.</li>
      </ul></section>
    </section>
    <section><div class="mw-heading mw-heading2"><h2 id="June">June</h2></div>
      <section><h3 id="30">30</h3><ul>
        <li id="june-person"><a href="//en.wikipedia.org/wiki/June_Person">June Person</a>, 82, British writer.</li>
      </ul></section>
    </section>
  `;

	const rows = parseWikipedia(annualSample, { monthName: 'June' });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].name, 'June Person');
	assert.equal(rows[0].wiki_path, 'June_Person');
});
