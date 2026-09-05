#!/usr/bin/env node
// Read-only early diagnostic, NOT proof of GitHub signature/login approval.
// No config mutation, credentials, commits, network or financial reads.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const fail=()=>{throw new Error('GIT_IDENTITY_INVALID');};
const identity=/^Claude <noreply@anthropic\.com> \d+ [+-]\d{4}$/;
export function checkGitIdentity(args,{cwd=process.cwd(),env=process.env,run=spawnSync}={}){
  const git=argv=>{
    const result=run('git',argv,{cwd,env,encoding:'utf8',timeout:10_000,maxBuffer:64_000});
    if(result.error||result.status!==0||typeof result.stdout!=='string')fail();
    return result.stdout.replace(/\n$/,'');
  };
  if(args.length===1&&args[0]==='effective'){
    for(const kind of ['AUTHOR','COMMITTER'])if(!identity.test(git(['var',`GIT_${kind}_IDENT`])))fail();
  }else if(args.length===2&&args[0]==='commit'&&/^[a-f0-9]{40}$/.test(args[1])){
    // cat-file refuses a blob/tree; parse the immutable object, not local config.
    const header=git(['cat-file','commit',args[1]]).split('\n\n',1)[0];
    for(const kind of ['author','committer']){
      const values=header.split('\n').filter(line=>line.startsWith(`${kind} `));
      if(values.length!==1||!identity.test(values[0].slice(kind.length+1)))fail();
    }
  }else fail();
  return {status:'ok',profile:'claude-candidate-v1',githubVerification:'not-checked'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.stdout.write(`${JSON.stringify(checkGitIdentity(process.argv.slice(2)))}\n`);}
  catch{process.stderr.write('GIT_IDENTITY_INVALID\n');process.exitCode=1;}
}
