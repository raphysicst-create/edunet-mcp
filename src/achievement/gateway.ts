import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workerResultSchema, type WorkerResult } from "./contracts.js";
import { createLogger } from "../logger.js";

export class WorkerUnavailableError extends Error { constructor(readonly code:string) { super(code); } }
export interface WorkerGateway { run(handle:string,signal?:AbortSignal):Promise<WorkerResult> }
export interface GatewayOptions {secret:string;timeoutMs?:number;maxConcurrent?:number;failureThreshold?:number;cooldownMs?:number;now?:()=>number;spawn?:()=>ChildProcess}
/** A new, memory-bounded process owns every file download and parser invocation. */
export function createWorkerGateway(options:GatewayOptions):WorkerGateway {
  const now=options.now ?? Date.now;
  const logger=createLogger();
  let active=0, failures=0, openUntil=0;
  return { async run(handle,signal) {
    if (signal?.aborted) throw new WorkerUnavailableError("ABORTED");
    if (now() < openUntil) throw new WorkerUnavailableError("WORKER_CIRCUIT_OPEN");
    if (active >= (options.maxConcurrent ?? 2)) throw new WorkerUnavailableError("WORKER_BUSY");
    active++;
    let child:ChildProcess|undefined;
    try {
      child=(options.spawn ?? (()=>fork(fileURLToPath(new URL("../worker/entry.js",import.meta.url)),[],{
        execArgv:["--max-old-space-size=256"],stdio:["ignore","ignore","ignore","ipc"],windowsHide:true,
        // Parser process does not need the search credential or unrelated host secrets.
        env:{PATH:process.env.PATH ?? "",SystemRoot:process.env.SystemRoot ?? "",TEMP:process.env.TEMP ?? "",TMP:process.env.TMP ?? "",EDUNET_REFERENCE_SECRET:options.secret},
      })))();
      const processChild=child;
      const result=await new Promise<WorkerResult>((resolve,reject)=>{
        let settled=false;
        const finish=(error:unknown,value?:WorkerResult):void=>{
          if(settled) return;settled=true;
          clearTimeout(timer);signal?.removeEventListener("abort",abort);processChild.removeAllListeners();
          processChild.on("error",()=>{});
          if (error) reject(error); else resolve(value!);
        };
        const abort=():void=>finish(new WorkerUnavailableError("ABORTED"));
        const timer=setTimeout(()=>finish(new WorkerUnavailableError("WORKER_TIMEOUT")),Math.min(options.timeoutMs ?? 30000,30000));
        signal?.addEventListener("abort",abort,{once:true});
        if(signal?.aborted) {abort();return;}
        processChild.once("error",()=>finish(new WorkerUnavailableError("WORKER_CONNECTION_FAILED")));
        processChild.once("exit",()=>finish(new WorkerUnavailableError("WORKER_EXITED")));
        processChild.once("message",message=>{
          try {
            if (JSON.stringify(message).length > 4_000_000) throw new Error("size");
            const parsed=workerResultSchema.parse(message);
            finish(null,parsed);
          } catch {finish(new WorkerUnavailableError("WORKER_INVALID_RESPONSE"));}
        });
        try {processChild.send({handle},error=>{if(error) finish(new WorkerUnavailableError("WORKER_CONNECTION_FAILED"));});}
        catch {finish(new WorkerUnavailableError("WORKER_CONNECTION_FAILED"));}
      });
      const documentOutputLimit=result.status==="parse_failed" && result.warnings.some(warning=>warning.code==="WORKER_OUTPUT_TOO_LARGE");
      if((result.status==="parse_failed" && !documentOutputLimit) || result.status==="worker_unavailable") {
        failures++;
        if(failures >= (options.failureThreshold ?? 3)) {openUntil=now()+(options.cooldownMs ?? 30000);logger.warn("worker_circuit_open",{failures});}
      } else {failures=0;openUntil=0;}
      return result;
    } catch(error) {
      if (!(error instanceof WorkerUnavailableError && ["ABORTED","WORKER_BUSY"].includes(error.code))) {
        failures++;
        if(failures >= (options.failureThreshold ?? 3)) {openUntil=now()+(options.cooldownMs ?? 30000);logger.warn("worker_circuit_open",{failures});}
      }
      throw error;
    } finally {active--;child?.kill();}
  }};
}
