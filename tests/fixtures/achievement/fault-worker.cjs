process.once('message',()=>{
  // Removing the last IPC listener otherwise lets Node exit before the timeout.
  if(process.env.FAULT_MODE==='timeout') setInterval(()=>{},1000);
  if(process.env.FAULT_MODE==='exit') process.exit(17);
  if(process.env.FAULT_MODE==='malformed') process.send({status:'made_up',records:'invalid'});
});
