import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.cwd();
const load = p => import(pathToFileURL(join(repo, p)).href);
const { resolveKinds } = await load('modules/agent-kinds/defaults.ts');
const { kindRegistrationPlan } = await load('modules/agent-kinds/index.ts');
const registry = await import('/Users/lyston/.pi/agent/npm/node_modules/pi-subagents/src/agents/runtime-agent-registry.js');
const fakeHost = { on() {}, registerTool() {} };
const plan = kindRegistrationPlan(resolveKinds(null), pathToFileURL(join(repo, 'modules/agent-kinds/index.ts')).href);
const registrations = plan.desired.map(x => registry.registerRuntimeAgent({pi: fakeHost, name: x.agent, definition:x.definition}));
console.log(JSON.stringify({probe:'registered-guidance', agents:registry.listRuntimeAgentConfigs(fakeHost).map(x=>({name:x.name,inheritProjectContext:x.inheritProjectContext,inheritSkills:x.inheritSkills,systemPromptMode:x.systemPromptMode}))}));
registrations.forEach(x=>x.dispose());
const { sessionTree, sessionWorktreeModule } = await load('modules/session-worktree/index.ts');
const { contextKeyFor } = await load('core/trellis.ts');
const { createConfigRootResolver } = await load('core/config.ts');
const { subagentContextModule, resolveChildTask } = await load('modules/subagent-context/index.ts');
const { overlapOf } = await load('modules/dispatch/index.ts');
console.log(JSON.stringify({probe:'path-alias-overlap',standard:overlapOf(['src/a.ts'],['src/a.ts']),alias:overlapOf(['src/a.ts'],['src/x/../a.ts'])}));
const base = realpathSync(mkdtempSync(join(tmpdir(),'cw-audit-contracts-')));
const root = join(base,'repo'); mkdirSync(root);
const env={...process.env,GIT_AUTHOR_NAME:'Audit fixture',GIT_AUTHOR_EMAIL:'audit@example.invalid',GIT_COMMITTER_NAME:'Audit fixture',GIT_COMMITTER_EMAIL:'audit@example.invalid',PYTHONDONTWRITEBYTECODE:'1'};
const git = (...args) => execFileSync('git',['-C',root,...args],{encoding:'utf8',env,stdio:['ignore','pipe','pipe']}).trim();
const put=(path,text)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,text);};
try {
 git('init','-b','main');put(join(root,'.gitignore'),'.trellis\n.pi\n');git('add','.gitignore');git('commit','-m','fixture');
 const tasks={};
 for(const name of ['a','b']) {const task=join(root,'.trellis/tasks',name);const worktree=join(base,'wt-'+name);git('worktree','add','-b','feat/'+name,worktree);put(join(task,'task.json'),JSON.stringify({status:'in_progress',branch:'feat/'+name,worktree_path:worktree}));put(join(task,'prd.md'),'TASK_'+name.toUpperCase());tasks[name]={task,worktree};}
 const pointer=join(root,'.trellis/.runtime/sessions',contextKeyFor('parent')+'.json');
 const setTask=name=>put(pointer,JSON.stringify({current_task:'.trellis/tasks/'+name}));
 setTask('a');
 const host={};const runtime={cwd:root,sessionId:'parent',enabled:true,isChild:false,control:{moduleEnabled:()=>true}};
 const first=sessionTree(host,runtime);setTask('b');const second=sessionTree(host,runtime);
 console.log(JSON.stringify({probe:'task-switch-placement',first:first.path,second:second.path,expected:tasks.b.worktree,childTask:resolveChildTask(root,'subagent-cw-executor-id-0','Active task: .trellis/tasks/b')}));
 // Injection is run with new event objects, as on a continued child turn.
 let handler; const childHost={on:(_event,fn)=>{handler=fn;return ()=>{};},getSessionName:()=> 'subagent-cw-worker-id-0'};
 const childRuntime={cwd:root,sessionId:'child',parentSessionId:'parent',isChild:true,enabled:true,configRoots:createConfigRootResolver(),control:{moduleEnabled:()=>true}};
 subagentContextModule.activate(childHost,childRuntime);
 const inject=prompt=>{const event={prompt,systemPrompt:'BASE',systemPromptOptions:{contextFiles:[],sections:{}}};handler(event,{cwd:root});return event.systemPromptOptions.sections.pi_coworkflow_child;};
 const independent=inject('Active task: (none)\nDo an independent bounded job.');const continued=inject('Continue the same assignment.');
 console.log(JSON.stringify({probe:'continued-independent-child',firstHasTaskB:independent.includes('TASK_B'),continuedHasTaskB:continued.includes('TASK_B')}));
 mkdirSync(join(root,'.trellis/spec'),{recursive:true});
 console.log(JSON.stringify({probe:'non-task-directory',result:resolveChildTask(root,undefined,'Active task: .trellis/spec')}));
 const shutdownHost={};const shutdownRuntime={...runtime,sessionId:'shutdown-probe'};
 const allocated=sessionTree(shutdownHost,shutdownRuntime);
 // A plain local process stands in for a child that has started but has not written yet.
 // This proves filesystem/lifecycle behavior, not native runner shutdown ordering.
 const resident=spawn(process.execPath,['-e',`process.send('ready'); process.on('message',()=>{let cwd;try{cwd=process.cwd()}catch(e){cwd=e.code}process.send({cwd});process.disconnect()});`],{cwd:allocated.path,stdio:['ignore','ignore','pipe','ipc']});
 await once(resident,'message');
 const exited=once(resident,'exit');
 sessionWorktreeModule.onSessionEnd(shutdownHost,shutdownRuntime);
 const response=once(resident,'message');resident.send('check');const [childState]=await response;await exited;
 console.log(JSON.stringify({probe:'cleanup-with-live-local-process',path:allocated.path,existsAfterShutdown:existsSync(allocated.path),childState}));
 const target=join(root,'.trellis/tasks/c');put(join(target,'task.json'),JSON.stringify({status:'in_progress',branch:'feat/c'}));
 const occupied=join(base,'wt-c');git('worktree','add','-b','foreign',occupied);
 execFileSync('python3',[join(repo,'modules/worktree/assets/auto_worktree.py')],{env:{...env,TASK_JSON_PATH:join(target,'task.json')},cwd:root,encoding:'utf8'});
 console.log(JSON.stringify({probe:'foreign-worktree-adoption',beforeBranch:'feat/c',after:JSON.parse(readFileSync(join(target,'task.json'),'utf8'))}));
} finally { rmSync(base,{recursive:true,force:true}); }
