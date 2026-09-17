import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as z from 'zod/v4';
import { searchInputSchema, searchOutputSchema } from '../dist/schema.js';

test('search input and output schemas exactly preserve RC baseline',()=>{
  const baseline=JSON.parse(readFileSync(new URL('./fixtures/achievement/search-contract.json',import.meta.url),'utf8'));
  assert.deepEqual(z.toJSONSchema(searchInputSchema),baseline.input);
  assert.deepEqual(z.toJSONSchema(searchOutputSchema),baseline.output);
});
