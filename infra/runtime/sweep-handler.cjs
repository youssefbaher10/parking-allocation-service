// Runtime JavaScript: reuse the existing transaction-safe allocation business logic.
const {sweep}=require('../../src/services/requestService');
exports.handler=async(event)=>{
  // One sweep per batch; SQS retries the batch on failure.
  if(event?.Records && !event.Records.every(r=>r.eventSource==='aws:sqs')) throw Error('Unexpected event');
  const result=await sweep();
  console.log(JSON.stringify({event:'allocation_sweep',...result}));
  return result;
};
