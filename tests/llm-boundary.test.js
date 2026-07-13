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
	const reads = [];
	const DB = {
		prepare(sql) {
			return {
				bind(...values) {
					return {
						async all() {
							reads.push(sql);
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
	return { env: { DB }, reads, writes };
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
	let fencedAfterUpdate = false;
	const result = await applyLlmOutput(
		env,
		JSON.stringify({
			selected: [{ name: '<script>evil</script>', wiki_path: 'Trusted_Person', description: 'fabricated', cause: 'fabricated' }],
			rejected: [],
		}),
		['Trusted_Person'],
		{
			beforeSideEffects: async () => {
				fencedAfterUpdate = writes.some((write) => write.sql.includes("llm_result = 'yes'"));
			},
		},
	);
	assert.equal(result.notified, 1);
	assert.equal(fencedAfterUpdate, true);
	const update = writes.find((write) => write.sql.includes("llm_result = 'yes'"));
	assert.deepEqual(update.values, ['canonical cause', 'Canonical Wikipedia description', 'Trusted_Person']);
});

test('selected notifications do not start until the side-effect fence succeeds', async () => {
	const { env, reads, writes } = makeEnv();
	await assert.rejects(
		() =>
			applyLlmOutput(env, JSON.stringify({ selected: [{ wiki_path: 'Trusted_Person' }], rejected: [] }), ['Trusted_Person'], {
				beforeSideEffects: async () => {
					throw new Error('fence failed');
				},
			}),
		/fence failed/,
	);
	assert.equal(
		writes.some((write) => write.sql.includes("llm_result = 'yes'")),
		true,
	);
	assert.equal(
		reads.some((sql) => sql.includes('FROM subscribers')),
		false,
	);
});
