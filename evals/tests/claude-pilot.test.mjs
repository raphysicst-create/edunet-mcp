import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { parseClaudeEvents, claudeSurfaceValid, claudeEnv } from '../claude-pilot.mjs';

test('Claude parser retains actual model, result and unexpected tool evidence',()=>{
 const p=parseClaudeEvents([{type:'system',subtype:'init',tools:['mcp__edunet__search_edunet'],session_id:'a'},{type:'assistant',message:{model:'claude-sonnet-test',content:[{type:'tool_use',name:'Read',id:'x',input:{}}]}},{type:'result',subtype:'success',result:'done',session_id:'a'}].map(JSON.stringify).join('\n'));
 assert.deepEqual(p.models,['claude-sonnet-test']);assert.equal(p.final,'done');assert.equal(p.attempts[0].name,'Read');assert.equal(claudeSurfaceValid(p.init),true);
 assert.equal(claudeSurfaceValid({tools:['Read','mcp__edunet__search_edunet']}),false);assert.equal(claudeSurfaceValid(null),false);
 assert.equal(claudeEnv().ANTHROPIC_API_KEY,undefined);
});
test('Claude MCP proxy preserves real SDK error result from an unrelated workspace',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'claude-proxy-test-'));
 const client=new Client({name:'claude-proxy-test',version:'1'});
 const transport=new StdioClientTransport({command:process.execPath,args:[resolve('evals/claude-mcp-proxy.mjs'),'--preflight',dir],cwd:dir,stderr:'pipe'});
 try{await client.connect(transport);await client.callTool({name:'search_edunet',arguments:{query:'광합성',page:51}});
 const files=readdirSync(dir).filter(f=>f.startsWith('call-'));assert.equal(files.length,1);
 const audit=JSON.parse(readFileSync(join(dir,files[0]),'utf8'));assert.equal(audit.arguments.page,51);assert.equal(audit.result.isError,true);
 }finally{await client.close();}
});
