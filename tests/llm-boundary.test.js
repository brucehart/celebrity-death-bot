import test from 'node:test';
import assert from 'node:assert/strict';

import { applyLlmOutput } from '../src/services/llm-output.ts';

const canonicalRow = {
	name: 'Trusted Person',
	wiki_path: 'Trusted_Person',
	link_type: 'active',
	age: 87,
	description: 'Canonical Wikipedia description',
	cause: 'canonical cause',
};

function makeEnv() {
	const writes = [];
	const DB = {
		prepare(sql) {
			return {
				bind(...values) {
					return {
						async all() {
							if (sql.includes('FROM deaths')) return { results: [canonicalRow] };
							if (sql.includes('FROM subscribers')) return { results: [] };
							return { results: [] };
						},
						async run() {
							writes.push({ sql, values });
							return { meta: { changes: 1 } };
						},
					};
				},
			};
		},
	};
	return { env: { DB }, writes };
}

test('LLM output is rejected without a trusted candidate set', async () => {
	await assert.rejects(() => applyLlmOutput({ DB: {} }, '{"selected":[]}', []), /trusted candidate set/);
});

test('LLM cannot select a wiki path outside the candidate batch', async () => {
	const { env, writes } = makeEnv();
	const result = await applyLlmOutput(env, JSON.stringify({ selected: [{ name: 'Attacker', wiki_path: 'Attacker_Path' }], rejected: [] }), [
		'Trusted_Person',
	]);
	assert.equal(result.notified, 0);
	assert.equal(writes.length, 0);
});

test('selected notifications and updates use canonical database fields', async () => {
	const { env, writes } = makeEnv();
	const result = await applyLlmOutput(
		env,
		JSON.stringify({
			selected: [{ name: '<script>evil</script>', wiki_path: 'Trusted_Person', description: 'fabricated', cause: 'fabricated' }],
			rejected: [],
		}),
		['Trusted_Person'],
	);
	assert.equal(result.notified, 1);
	const update = writes.find((write) => write.sql.includes("llm_result = 'yes'"));
	assert.deepEqual(update.values, ['canonical cause', 'Canonical Wikipedia description', 'Trusted_Person']);
});
