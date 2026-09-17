// Per-run synthetic EDUNET backend for subscription-session evaluation.
// This process is only the MCP server's backend; its fixture is never placed
// in the model workspace or prompt.
import { readFileSync } from 'node:fs';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../dist/server.js';
import { canary } from './lib.mjs';
import { createMockSearch, mockErrorFormatter } from './mock-backend.mjs';

const fixturePath = process.argv[2];
if (!fixturePath) throw new Error('fixture path required');
const preflight = { id: 'preflight', mockApiResponses: [{ kind: 'synthetic', id: 'preflight-zero', match: { concepts: [['광합성']] }, response: { items: [], totalCount: 0 } }] };
const parsed = fixturePath === '--preflight' ? preflight : JSON.parse(readFileSync(fixturePath, 'utf8'));
const scenario = Array.isArray(parsed) ? { id: 'stdio-fixture', mockApiResponses: parsed } : parsed;
const server = createServer(createMockSearch(scenario, { apiKey: canary }), { errorFormatter: mockErrorFormatter });
serveStdio(() => server);
