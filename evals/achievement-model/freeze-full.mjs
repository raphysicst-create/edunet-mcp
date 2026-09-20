import fs from 'node:fs';
import path from 'node:path';
import {args,read,write,sha,MODELS} from './common.mjs';
const o=args(),root=path.resolve(o.out),original=read(path.join(root,'evaluation-lock.json'));
for(const stage of ['connection','representative']){
  const summary=read(path.join(root,stage,'summary.json'));
  if(summary.length!==2||summary.some(s=>!s.complete||s.stopped))throw Error('PILOT_STAGE_INCOMPLETE');
}
for(const [f,h]of Object.entries(original.runnerHashes))if(sha(fs.readFileSync(path.join(root,'runner-snapshot',f)))!==h)throw Error('ORIGINAL_RUNNER_SNAPSHOT_MISMATCH');
for(const [model,settings]of Object.entries(MODELS))if(settings.model!==original.models[model].requestedModel||settings.effort!==original.models[model].requestedEffort)throw Error('MODEL_SETTINGS_CHANGED');
const names=['common.mjs','proxy.mjs','run.mjs','runner.test.mjs','scheduler.mjs','scheduler.test.mjs'];
const runnerHashes=Object.fromEntries(names.map(f=>[f,sha(fs.readFileSync(path.join(import.meta.dirname,f)))]));
const snapshot=path.join(root,'full-runner-snapshot');fs.mkdirSync(snapshot);
for(const f of names)fs.copyFileSync(path.join(import.meta.dirname,f),path.join(snapshot,f),fs.constants.COPYFILE_EXCL);
write(path.join(root,'full-stage-lock.json'),{createdAt:new Date().toISOString(),scope:'Full stage only; original pilot artifacts and lock retained',originalLockHash:sha(fs.readFileSync(path.join(root,'evaluation-lock.json'))),pilotRunnerHashes:original.runnerHashes,runnerHashes,
  changes:['Independent sessions raised from 1 to 3 per model (6 overall) after connection/representative checks','Mask two-part signed reference strings in persisted evidence; wire responses and model inputs unchanged','Record session timeouts/missing final answers as incomplete outcomes without abandoning other scenarios; provider/environment failures stop new jobs'],
  unchanged:['90 questions and scenario IDs','Luna high and Haiku no effort override','RC4 endpoint/manifests','Common model instructions and tool schema','600-second session and 60-call limits','No correction/replay of model arguments or responses'],
  reviewReferenceHash:sha(fs.readFileSync(path.join(root,'review-reference.json'))),modelConcurrency:3,totalConcurrency:6,timeoutMs:600000,toolCallLimit:60,releaseEligible:false});
console.log(JSON.stringify({fullStageFrozen:true,modelConcurrency:3,totalConcurrency:6,files:names.length}));
