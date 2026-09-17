import test from 'node:test';
import assert from 'node:assert/strict';
import { createAchievementSearch } from '../dist/achievement/search-orchestrator.js';
import { registerAchievementTools } from '../dist/achievement/register.js';
import { ReferenceCodec } from '../dist/achievement/references.js';

const secret = 'rc-cancellation-fixture-secret-at-least-32-bytes';
const references = new ReferenceCodec(secret);
const resource = { id: '123', title: '과학 성취수준', sourceUrl: 'https://www.edunet.net/clssStdDt/view/150/123' };
const result = input => ({ conditions: input, items: [{ id: resource.id, title: resource.title, content: '', contentTruncated: false, url: resource.sourceUrl, category: 'evl_data' }], pagination: { hasNextPage: false } });
const aborted = error => error.code === 'ABORTED' && !error.message.includes('private-reason');

test('pre-cancelled discovery is ABORTED and does not start upstream work', async () => {
  let calls = 0;
  const search = createAchievementSearch({ references, registry: [], search: async input => { calls++; return result(input); } });
  await assert.rejects(search({ query: '과학' }, AbortSignal.abort(new Error('private-reason'))), aborted);
  assert.equal(calls, 0);
});

test('discovery cancellation interrupts search and metadata even if dependencies ignore abort', async () => {
  for (const stage of ['search', 'metadata']) {
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    let metadataCalls = 0;
    const search = createAchievementSearch({ references, registry: [],
      search: async input => {
        if (stage === 'search') { entered.resolve(); return new Promise(() => {}); }
        return result(input);
      },
      resolveResource: async () => { metadataCalls++; entered.resolve(); return new Promise(() => {}); },
    });
    const pending = search({ query: '과학' }, controller.signal);
    await entered.promise;
    const start = performance.now();
    controller.abort(new Error('private-reason'));
    await assert.rejects(pending, aborted);
    assert.ok(performance.now() - start < 1000);
    assert.equal(metadataCalls, stage === 'search' ? 0 : 1);
  }
});

test('all achievement MCP handlers expose cancellation as a terminal ABORTED error', async () => {
  const handlers = new Map();
  let calls = 0;
  registerAchievementTools({ registerTool(name, _definition, handler) { handlers.set(name, handler); } },
    async input => { calls++; return result(input); }, {
      references,
      config: { searchEnabled: true, pdfReadEnabled: true, hwpReadEnabled: false, hwpxReadEnabled: false, autoAttachmentSelectionEnabled: false, resourceReadEnabled: true, referenceSecret: secret },
      resolveResource: async value => { calls++; return { resource: value, attachments: [], warnings: [] }; },
      gateway: { run: async () => { calls++; throw new Error('must not run'); } },
    });
  const cases = [
    ['search_edunet_achievement', { query: '과학' }],
    ['read_edunet_achievement', { achievementRef: references.issue('achievement', { resource }) }],
    ['read_edunet_resource', { resourceRef: references.issue('resource', { resource }) }],
  ];
  for (const [name, input] of cases) {
    const response = await handlers.get(name)(input, { mcpReq: { signal: AbortSignal.abort(new Error('private-reason')) } });
    assert.equal(response.isError, true, name);
    assert.equal(response._meta['edunet/errorCode'], 'ABORTED', name);
    assert.match(response.content[0].text, /자동 재호출을 중단/);
    assert.doesNotMatch(JSON.stringify(response), /private-reason|stack/);
  }
  assert.equal(calls, 0);
});
