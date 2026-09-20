// Every job is claimed once. A fatal result stops new claims, not in-flight evidence collection.
export async function schedule(queue,worker,{concurrency=1,isFatal=()=>false}={}){
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>3)throw Error('INVALID_CONCURRENCY');
  let next=0,stopped=null;const results=[];
  const lane=async()=>{
    while(!stopped&&next<queue.length){const index=next++;const result=await worker(queue[index],index);results.push({index,result});if(isFatal(result)&&!stopped)stopped={index,result};}
  };
  await Promise.all(Array.from({length:concurrency},lane));
  return {results:results.sort((a,b)=>a.index-b.index).map(x=>x.result),stopped};
}
