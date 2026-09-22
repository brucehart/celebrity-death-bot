import test from 'node:test';
import assert from 'node:assert/strict';

import { callOpenAI, DEFAULT_OPENAI_MODEL, normalizeOpenAIModel } from '../src/services/openai.ts';

test('OpenAI requests default to GPT-6 Luna', async () => {
	assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-6-luna');
	assert.equal(normalizeOpenAIModel(), 'gpt-6-luna');

	const originalFetch = globalThis.fetch;
	let requestBody;
	globalThis.fetch = async (_input, init) => {
		requestBody = JSON.parse(String(init?.body));
		return Response.json({ id: 'resp_test', status: 'completed', output_text: '{"selected":[],"rejected":[]}' });
	};

	try {
		const response = await callOpenAI({ OPENAI_API_KEY: 'test-key', BASE_URL: 'https://example.com' }, 'test prompt');
		assert.equal(response.model, 'gpt-6-luna');
		assert.equal(requestBody.model, 'gpt-6-luna');
		assert.equal(requestBody.input, 'test prompt');
	} finally {
		globalThis.fetch = originalFetch;
	}
});
