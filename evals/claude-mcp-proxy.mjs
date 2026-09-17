// Preserve the real JSON-RPC tool result, including SDK validation failures.
// Audit output and fixture stay outside the model workspace.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeJson } from './lib.mjs';
const [fixture, audit] = process.argv.slice(2);
const child = spawn(process.execPath, [fileURLToPath(new URL('./mock-stdio-server.mjs',import.meta.url)), fixture], { stdio: ['pipe','pipe','pipe'], windowsHide:true });
let incoming='', outgoing='', sequence=0;
const requests=new Map();
process.stdin.on('data', data => {
  incoming += data.toString();
  let i;
  while ((i=incoming.indexOf('\n'))>=0) {
    const line=incoming.slice(0,i); incoming=incoming.slice(i+1);
    try { const m=JSON.parse(line); if(m.method==='tools/call') requests.set(m.id,{id:m.id,name:m.params.name,arguments:m.params.arguments}); } catch {}
  }
  child.stdin.write(data);
});
child.stdout.on('data',data=>{
  outgoing+=data.toString(); let i;
  while((i=outgoing.indexOf('\n'))>=0) {
    const line=outgoing.slice(0,i); outgoing=outgoing.slice(i+1);
    try {const m=JSON.parse(line),request=requests.get(m.id); if(request){writeJson(`${audit}/call-${++sequence}.json`,{...request,result:m.result??null,rpcError:m.error??null});requests.delete(m.id);}} catch {process.stderr.write('Audit or protocol failure\n');process.exitCode=1;}
  }
  process.stdout.write(data);
});
child.stderr.on('data',()=>{});
process.stdin.on('end',()=>child.stdin.end());
child.on('error',()=>process.exit(1));
child.on('close',code=>process.exit(code??1));
