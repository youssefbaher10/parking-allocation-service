import http from 'k6/http';
import {check,sleep} from 'k6';
import {Counter} from 'k6/metrics';
const base='http://localhost:8080';
const workers=[new Counter('served_by_allocation_1'),new Counter('served_by_allocation_2'),new Counter('served_by_allocation_3')];
const vus=Number(__ENV.VUS||10);
export const options={stages:[{duration:'10s',target:vus},{duration:'30s',target:vus},{duration:'10s',target:0}],thresholds:{http_req_failed:['rate<0.05'],http_req_duration:['p(95)<500']}};
export default function(){
 const token=__ENV.PARKING_TEST_TOKEN;
 const endpoint=token?'/api/allocation/requests':'/health';
 const r=http.get(base+endpoint,{headers:token?{Authorization:`Bearer ${token}`}:{}});
 const instance=r.headers['X-Parking-Instance'];
 if(/^allocation-[1-3]$/.test(instance||''))workers[Number(instance.slice(-1))-1].add(1);
 check(r,{'HTTP 200':x=>x.status===200,'worker identified':()=>Boolean(instance)});sleep(0.1);
}
