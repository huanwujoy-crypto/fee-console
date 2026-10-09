import assert from "node:assert/strict";
import fs from "node:fs";
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from "node:test";
import { consecutiveFailures, diagnosticBody, isValidatedProducer } from "./fee-cloud-supervisor.mjs";

const run = (conclusion, id, event = "schedule") => ({
  id, status: "completed", conclusion, event,
  producerValidated: conclusion === 'success',
  created_at: `2026-10-01T0${id}:00:00Z`, html_url: `https://github.test/runs/${id}`,
});

test("supervisor escalates only consecutive scheduled or manual producer failures", () => {
  assert.equal(consecutiveFailures([run("failure", 3), run("failure", 2), run("success", 1)]), 2);
  assert.equal(consecutiveFailures([run("failure", 3), run("success", 2), run("failure", 1)]), 1);
  assert.equal(consecutiveFailures([run("failure", 3, "push"), run("failure", 2), run("failure", 1)]), 2);
});

test('outer workflow timeout counts as failure and cancellation does not manufacture one', () => {
  assert.equal(consecutiveFailures([run('timed_out',3),run('cancelled',2),run('timed_out',1)]),2);
  assert.match(diagnosticBody([run('timed_out',3),run('timed_out',1)]),/runs\/3/);
});

function executionFixture() {
  const now = new Date();
  const execution={id:99,status:'completed',conclusion:'success',event:'schedule',head_branch:'main',head_sha:'a'.repeat(40),
    created_at:new Date(now.getTime()-60000).toISOString(),updated_at:now.toISOString()};
  return {run:execution,jobs:{total_count:1,jobs:[{run_id:execution.id,head_sha:execution.head_sha,status:'completed',conclusion:'success',
    steps:['Read, calculate and validate the encrypted candidate','Create a signed owner candidate']
      .map(name=>({name,status:'completed',conclusion:'success'}))}]}};
}

test('execution reset requires actual source/writer/signing steps and matching job/run identity', () => {
  const f=executionFixture();assert.equal(isValidatedProducer(f.run,f.jobs),true);
  const mutations=[f=>f.jobs.jobs[0].steps[0].conclusion='skipped',f=>f.jobs.jobs[0].steps[1].conclusion='skipped',
    f=>f.jobs.total_count=2,f=>f.jobs.jobs[0].steps.push({...f.jobs.jobs[0].steps[0]}),
    f=>f.run.head_branch='candidate',f=>f.jobs.jobs[0].run_id=1,f=>f.jobs.jobs[0].head_sha='b'.repeat(40),
    f=>f.jobs.jobs[0].status='in_progress',f=>f.jobs.jobs[0].conclusion='failure'];
  for(const change of mutations){const x=executionFixture();change(x);assert.equal(isValidatedProducer(x.run,x.jobs),false);}
  const skip={...run('success',2),producerValidated:false};
  assert.equal(consecutiveFailures([skip,run('failure',3),run('failure',1)]),2);
});

test('actual supervisor never auto-closes from unrelated publication and honors historical execution reset', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-supervisor-test-'));
  try {
    for(const scenario of ['skip','validated','failure-after-recovery','failure-after-skip','timed-out']) {
      const f=executionFixture(),out=path.join(dir,'observations.json'),preload=path.join(dir,'mock.mjs');
      fs.writeFileSync(preload,`import fs from 'node:fs';const f=${JSON.stringify(f)},scenario=${JSON.stringify(scenario)},observed={mutations:[],jobs:[]};
const flush=()=>fs.writeFileSync(${JSON.stringify(out)},JSON.stringify(observed));
globalThis.fetch=async(url,init={})=>{
 let value;
 if(init.method){observed.mutations.push({method:init.method,body:JSON.parse(init.body)});flush();value={};}
 else if(url.includes('fee-cloud-producer.yml/runs'))value={workflow_runs:scenario==='timed-out'?
   [{...f.run,id:2,conclusion:'timed_out'},{...f.run,id:1,conclusion:'timed_out'}]:scenario.startsWith('failure-')?
   [{...f.run,id:3,conclusion:'failure'},{...f.run,id:2,producerValidated:true},{...f.run,id:1,conclusion:'failure'}]:[f.run]};
 else if(url.includes('/issues?'))value=scenario==='failure-after-recovery'?[]:[{number:1,title:'[fee-cloud] producer needs Codex diagnosis'}];
 else if(url.includes('/jobs?')){const id=Number(new URL(url).pathname.split('/').at(-2));observed.jobs.push(id);flush();value=f.jobs;value.jobs[0].run_id=id;
   if(scenario==='skip'||scenario==='failure-after-skip')value.jobs[0].steps[0].conclusion='skipped';}
 else throw Error('publication or financial request forbidden in supervisor fixture');
 const r=new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});Object.defineProperty(r,'url',{value:url});return r;
};`);
      fs.writeFileSync(out,JSON.stringify({mutations:[],jobs:[]}));
      const result=spawnSync(process.execPath,['--import',preload,new URL('./fee-cloud-supervisor.mjs',import.meta.url).pathname],{
        encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,GITHUB_REPOSITORY:'huanwujoy-crypto/fee-console',GITHUB_TOKEN:'synthetic-observer-token'}});
      assert.equal(result.status,0,result.stderr);
      const observed=JSON.parse(fs.readFileSync(out));
      assert.doesNotMatch(result.stdout,/HEALTHY/);
      assert.equal(observed.jobs.length,scenario==='timed-out'?0:1);
      assert.equal(observed.mutations.length,['failure-after-skip','timed-out'].includes(scenario)?1:0);
      assert.ok(observed.mutations.every(m=>m.body.state!=='closed'));
      if(scenario==='failure-after-recovery')assert.match(result.stdout,/WAITING failures=1/);
      if(['failure-after-skip','timed-out'].includes(scenario))assert.match(result.stdout,/ESCALATED failures=2/);
    }
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test("diagnostic issue is amount-free and forbids direct ledger repair", () => {
  const body = diagnosticBody([run("failure", 3), run("failure", 2)]);
  assert.match(body, /Codex repair candidate only/);
  assert.match(body, /Do not edit the formal encrypted ledger/);
  assert.match(body, /https:\/\/github\.test\/runs\/3/);
  assert.doesNotMatch(body, /\$[0-9]/);
});

test("supervisor workflow has no source or ledger secrets", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/fee-cloud-supervisor.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /Fee console cloud producer/);
  assert.match(workflow, /actions: read/);
  assert.match(workflow, /issues: write/);
  assert.doesNotMatch(workflow, /FEE_DATA_KEY|FEE_ECON_GIST_ID|SHARESIGHT|id-token: write/);
});

// Public-only observation must also detect a producer that never started.
import './fee-observation.test.mjs';
