import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { checkGitIdentity } from './xuan-ib-git-identity-preflight.mjs';

const good='Claude <noreply@anthropic.com> 1788570000 +0000';
const mock=(author=good,committer=good)=>({run:(_cmd,args)=>({status:0,stdout:args[0]==='cat-file'
  ?`tree ${'0'.repeat(40)}\nauthor ${author}\ncommitter ${committer}\n\nmessage\n`
  :`${args[1]==='GIT_AUTHOR_IDENT'?author:committer}\n`})});
test('canonical effective identities pass, but do not claim GitHub validation',()=>{
  assert.deepEqual(checkGitIdentity(['effective'],mock()),{status:'ok',profile:'claude-candidate-v1',githubVerification:'not-checked'});
});
test('malformed/injected author or committer is rejected without echoing its value',()=>{
  for(const bad of ['Claudethropic.com <noreply@an> 1788570000 +0000','',good+'\n'+good,good.replace('Claude','Owner'),good.replace('anthropic.com','example.com')]){
    for(const pair of [[bad,good],[good,bad]])assert.throws(()=>checkGitIdentity(['effective'],mock(...pair)),/^Error: GIT_IDENTITY_INVALID$/);
  }
});
test('real git effective identity observes bad env even over canonical config',()=>{
  const env={...process.env,GIT_CONFIG_COUNT:'2',GIT_CONFIG_KEY_0:'user.name',GIT_CONFIG_VALUE_0:'Claude',GIT_CONFIG_KEY_1:'user.email',GIT_CONFIG_VALUE_1:'noreply@anthropic.com',GIT_AUTHOR_NAME:'Claudethropic.com',GIT_AUTHOR_EMAIL:'noreply@an',GIT_COMMITTER_NAME:'Claude',GIT_COMMITTER_EMAIL:'noreply@anthropic.com'};
  assert.throws(()=>checkGitIdentity(['effective'],{env,run:spawnSync}),/GIT_IDENTITY_INVALID/);
  assert.equal(checkGitIdentity(['effective'],{env:{...env,GIT_AUTHOR_NAME:'Claude',GIT_AUTHOR_EMAIL:'noreply@anthropic.com'}}).status,'ok');
});
test('commit verifies actual object identities and rejects unsafe/noncommit inputs',()=>{
  assert.equal(checkGitIdentity(['commit','a'.repeat(40)],mock()).status,'ok');
  assert.throws(()=>checkGitIdentity(['commit','a'.repeat(40)],mock('bad')),/GIT_IDENTITY_INVALID/);
  for(const args of [[],['effective','override'],['commit','HEAD'],['commit','--help'],['commit','a'.repeat(39)]])assert.throws(()=>checkGitIdentity(args,mock()),/GIT_IDENTITY_INVALID/);
});
test('git failures stop before any financial reader would be called',()=>{
  for(const result of [{status:1,stderr:'private'},{status:null,error:new Error('private')},{status:0,stdout:null}]){
    let reads=0;
    assert.throws(()=>{checkGitIdentity(['effective'],{run:()=>result});reads+=1;},/^Error: GIT_IDENTITY_INVALID$/);
    assert.equal(reads,0);
  }
});
