process.once('message',()=>{
  if(process.env.FAULT_MODE==='exit') process.exit(17);
  if(process.env.FAULT_MODE==='malformed') process.send({status:'made_up',records:'invalid'});
});
