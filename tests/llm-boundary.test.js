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

const rejectedRow = {
	...canonicalRow,
	name: 'Rejected Person',
	wiki_path: 'Rejected_Person',
};

function makeEnv({ deathRows = [canonicalRow], failSubscriberRead = false } = {}) {
	const writes = [];
	const reads = [];
	const DB = {
		prepare(sql) {
			return {
				bind(...values) {
					return {
						async all() {
							reads.push(sql);
							if (sql.includes('FROM deaths')) return { results: deathRows };
							if (sql.includes('FROM subscribers')) {
								if (failSubscriberRead) throw new Error('notification lookup failed');
								return { results: [] };
							}
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
		async batch(statements) {
			return Promise.all(statements.map((statement) => statement.run()));
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

test('synchronous send failures leave selected deaths pending for retry', async () => {
	const { env, reads, writes } = makeEnv({ failSubscriberRead: true });
	await assert.rejects(
		() => applyLlmOutput(env, JSON.stringify({ selected: [{ wiki_path: 'Trusted_Person' }], rejected: [] }), ['Trusted_Person']),
		/notification lookup failed/,
	);
	assert.equal(
		reads.some((sql) => sql.includes('FROM subscribers')),
		true,
	);
	assert.equal(
		writes.some((write) => write.sql.includes("llm_result = 'yes'")),
		false,
	);
});

test('synchronous send failures still persist independent rejections', async () => {
	const { env, writes } = makeEnv({ deathRows: [canonicalRow, rejectedRow], failSubscriberRead: true });
	await assert.rejects(
		() =>
			applyLlmOutput(
				env,
				JSON.stringify({
					selected: [{ wiki_path: 'Trusted_Person' }],
					rejected: [{ wiki_path: 'Rejected_Person', reason: 'Not notable' }],
				}),
				['Trusted_Person', 'Rejected_Person'],
			),
		/notification lookup failed/,
	);
	const rejectionUpdate = writes.find((write) => write.sql.includes("llm_result = 'no'"));
	assert.ok(rejectionUpdate);
	assert.deepEqual(rejectionUpdate.values, ['Not notable', 'Rejected_Person']);
	assert.equal(
		writes.some((write) => write.sql.includes("llm_result = 'yes'")),
		false,
	);
});
