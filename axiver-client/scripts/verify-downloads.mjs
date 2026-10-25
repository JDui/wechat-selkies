// Isolated WebView2 smoke check. Uses a disposable EXE/profile/SQLite DB,
// never the portable user's cookies or settings. No Playwright or hashes.
import { createServer } from 'node:http';
import { mkdtemp, copyFile, readFile, writeFile, access, mkdir, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';

const exe = resolve(process.argv[2] || 'target/release/axiver-client.exe');
const root = await mkdtemp(join(tmpdir(), 'axiver-download-check-'));
const artifacts = resolve(process.argv[3] || '../screenshots/download-check');
await mkdir(artifacts, { recursive: true });
const stamp = Date.now();
const body = 'AXIVER isolated download check / 中文 / ' + stamp + '\n';
const requests = [];
const progressBody=Buffer.alloc(2*1024*1024,0x61);
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url.startsWith('/api/dock-download/file/')) {
    if (!req.headers.cookie?.includes('fixture_session=ok')) {
      res.writeHead(401).end();
      return;
    }
    const name = `axiver-check-${stamp}-${new URL(req.url, 'http://fixture').pathname.split('/').pop()}.txt`;
    const progress=req.url.includes('/progress-');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
      ...(req.url.includes('/progress-known')?{'Content-Length':progressBody.length}:{}),
    });
    if(progress){
      let sent=0;
      const timer=setInterval(()=>{const end=Math.min(sent+65536,progressBody.length);res.write(progressBody.subarray(sent,end));sent=end;if(sent===progressBody.length){clearInterval(timer);res.end();}},150);
      res.on('close',()=>clearInterval(timer));
    }else res.end(body);
  } else if (req.url.startsWith('/uploader/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Isolated uploader fixture</title><script>window.__fixtureSharedSession='+Boolean(req.headers.cookie?.includes('fixture_session=ok'))+'</script><h1>Integrated session tool</h1>');
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'fixture_session=ok; SameSite=Lax; Path=/' });
    res.end('<!doctype html><meta charset="utf-8"><title>AXIVER Frost Fixture</title><style>body{margin:0;background:#dce8f3;color:#172e45;font:24px/1.8 system-ui}p{margin:0}input{font:inherit}</style>'+Array.from({length:35},(_,i)=>'<p>AXIVER 0123456789 · Frosted background '+i+' · 中文清晰背景</p>').join('')+'<input id="remote-input">');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const portServer = createServer();
portServer.listen(0, '127.0.0.1');
await once(portServer, 'listening');
const debugPort = portServer.address().port;
await new Promise(r => portServer.close(r));
await copyFile(exe, join(root, 'AXIVER-Client.exe'));
execFileSync('python', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)'); c.executemany('INSERT INTO settings VALUES(?,?)',[('broadcast_name','AXIVER-ISOLATED-CHECK'),('wide_url',sys.argv[2])]); c.commit()`, join(root, 'axiver-client.db'), origin]);
const downloadDir=join(root,'selected downloads');
await mkdir(downloadDir,{recursive:true});
await writeFile(join(root,"download-settings.json"),JSON.stringify({mode:"default",directory:downloadDir}));
const child = spawn(join(root, 'AXIVER-Client.exe'), [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}` },
  stdio: ['ignore','pipe','pipe'], windowsHide: true,
});
let childExit=null;let childErrors="";let stopping=false;
child.stderr.on("data",data=>{childErrors=(childErrors+data.toString()).slice(-6000);});
child.on("exit",(code,signal)=>{childExit={code,signal};if(code&&!stopping)console.log("Isolated client exited:",code,childErrors);});
const sockets = [];
let nextId = 0;
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open');
  sockets.push(ws);
  const pending = new Map();
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  ws.addEventListener('close',()=>{for(const item of pending.values())item.reject(new Error('Isolated WebView2 closed'));pending.clear();});
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error("CDP timed out: "+method));},10000);
    pending.set(id,{resolve:r=>{clearTimeout(timer);resolve(r);},reject:e=>{clearTimeout(timer);reject(e);}});
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const result = await fn(); if (result) return result; } catch {}
    await pause(300);
  }
  throw new Error('Timed out waiting for isolated WebView2 state');
}
const results = [];
const uiResults = {};
let inspectFailure=async()=>({});
try {
  const targets=()=>fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r=>r.json());
  const shellTarget=await waitFor(async()=>(await targets()).find(t=>t.url.endsWith('/shell.html')));
  const shell=await connect(shellTarget);
  const evaluate=async expression=>{const r=await shell('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result?.value;};
  await waitFor(()=>evaluate('Boolean(window.__AXIVER_SHELL__?.layout)'));
  const nativeShot=name=>JSON.parse(execFileSync('powershell',['-NoProfile','-File',resolve('scripts/inspect-window.ps1'),'-TargetProcessId',String(child.pid),'-OutputPath',join(artifacts,name+'.png')],{encoding:'utf8'}));
  const waitingTarget=(await targets()).find(t=>t.url.endsWith('/waiting.html'));
  if(waitingTarget){
    const waiting=await connect(waitingTarget);
    uiResults.waitingUsesUnifiedLogo=await waitFor(async()=>{
      const logo=await waiting('Runtime.evaluate',{expression:'Boolean(document.querySelector("img.logo")?.naturalWidth && document.querySelector("img.logo").getAttribute("src")==="./brand-mark.svg")',returnByValue:true});
      return logo.result?.value===true;
    });
    nativeShot('00-waiting-unified-logo');
  }
  const remoteTarget=await waitFor(async()=>(await targets()).find(t=>t.url.startsWith(origin)),60000);
  const remote=await connect(remoteTarget);
  const remoteEval=async expression=>{const r=await remote('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});return r.result?.value;};
  const click=async selector=>{const p=await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:"nearest"});const r=element.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await shell('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await shell('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});};
  inspectFailure=async()=>({records:await evaluate('window.__TAURI__.core.invoke("client_get_downloads").then(r=>r.data)'),feedback:await evaluate('document.getElementById("download-feedback").textContent'),native:nativeShot("failure-window")});
  const records=()=>evaluate('window.__TAURI__.core.invoke("client_get_downloads").then(r=>r.data)');
  uiResults.startsCollapsed=await evaluate('document.getElementById("panel").hidden');
  const pillMetrics=()=>evaluate('(()=>{const pill=document.getElementById("pill"),label=document.getElementById("pill-label"),dot=document.getElementById("pill-dot"),style=getComputedStyle(pill);return {width:pill.getBoundingClientRect().width,expected:label.getBoundingClientRect().width+dot.getBoundingClientRect().width+parseFloat(style.columnGap)+parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+2,height:pill.offsetHeight,viewWidth:window.__AXIVER_SHELL__.layout.width,text:label.textContent};})()');
  await pause(350);
  const initialPill=await pillMetrics();
  uiResults.initialPill=initialPill;
  uiResults.compactPill=initialPill.width<128&&initialPill.height===26&&Math.abs(initialPill.width-initialPill.expected)<1&&Math.abs(initialPill.viewWidth-Math.ceil(initialPill.width))<1;
  uiResults.pillBlurReducedTwentyPercent=await evaluate('getComputedStyle(document.getElementById("pill"),"::before").filter.includes("blur(7.2px)")');
  await waitFor(()=>evaluate('document.documentElement.classList.contains("has-backdrop")'));
  await click('#pill');await waitFor(()=>evaluate('!document.getElementById("panel").hidden'));
  uiResults.frostFilter=await evaluate('getComputedStyle(document.getElementById("panel"),"::before").filter');
  uiResults.native=nativeShot('01-frosted-connection');
  const firstFrame=await evaluate('document.documentElement.style.getPropertyValue("--backdrop")');
  await remoteEval('document.body.style.backgroundColor="#f5e4d4"');
  await waitFor(async()=>await evaluate('document.documentElement.style.getPropertyValue("--backdrop")')!==firstFrame);
  uiResults.backdropUpdates=true;
  await click('#tab-settings');await click('#connection-settings summary');await click('#broadcast-name');
  await shell('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await shell('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await waitFor(()=>evaluate('document.getElementById("save-status").textContent.includes("已保存")'));
  uiResults.enterSaves=true;nativeShot('02-frosted-settings');
  await click('#btn-hide');await waitFor(()=>evaluate('document.getElementById("panel").hidden'));
  if(process.env.AXIVER_SKIP_RETURN!=="1"){
  const point={x:50,y:13};
  await shell('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
  await shell('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x+180,y:point.y+110,button:'left',buttons:1});
  await waitFor(()=>evaluate('window.__AXIVER_SHELL__.layout.x>100'));
  await shell('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
  await pause(8000);
  uiResults.staysBeforeTenSeconds=await evaluate('window.__AXIVER_SHELL__.layout.x>100');
  const heldX=await evaluate("window.__AXIVER_SHELL__.layout.x");
  const samples=[];const start=Date.now();
  while(Date.now()-start<3600){samples.push(await evaluate('window.__AXIVER_SHELL__.layout.x'));await pause(20);}
  uiResults.smoothReturnSamples=[...new Set(samples.filter(x=>Math.abs(x-heldX)>.1&&Math.abs(x-12)>.1).map(x=>Math.round(x*100)/100))].length;
  uiResults.smoothReturn=uiResults.smoothReturnSamples>=8;
  uiResults.returnTrajectory=[...new Set(samples.map(x=>Math.round(x*100)/100))];
  uiResults.returnedHome=await evaluate('window.__AXIVER_SHELL__.layout.x===12&&window.__AXIVER_SHELL__.layout.y===12');
  uiResults.dragDidNotOpen=await evaluate('document.getElementById("panel").hidden');
  }
  const forbidden=await remote('Runtime.evaluate',{expression:'window.__TAURI__.core.invoke("client_get_downloads").then(r=>!r.ok,e=>true)',returnByValue:true,awaitPromise:true});
  uiResults.remoteDownloadsDenied=forbidden.result?.value===true;
  async function switchMode(mode){
    if(await evaluate('document.getElementById("panel").hidden')){await click('#pill');await waitFor(()=>evaluate('!document.getElementById("panel").hidden'));}
    await click('#tab-settings');await click('#download-mode-'+(mode==='ask'?'ask':'default'));
    await waitFor(()=>evaluate(`window.__TAURI__.core.invoke('client_get_download_settings').then(r=>r.data.mode===${JSON.stringify(mode)})`));
    if(mode==='ask'){await click('#btn-hide');await waitFor(()=>evaluate('document.getElementById("panel").hidden'));}
  }
  async function request(name,expression,{cancel=false,cancelDialog=false,ask=false}={}) {
    const filename=`axiver-check-${stamp}-${name}.txt`;
    await remote('Runtime.evaluate',{expression,userGesture:false,awaitPromise:true});
    const record=await waitFor(async()=>(await records()).find(r=>r.name===filename&&r.status===(ask?'choosing':'pending')));
    const file=join(downloadDir,filename);
    await pause(350);
    let exists=false;try{await access(file);exists=true;}catch{}
    uiResults.waitsForConfirmation=uiResults.waitsForConfirmation!==false&&!exists;
    if(cancel){await click(`[data-cancel="${record.id}"]`);}
    else if(!ask){
      if(name==='http')nativeShot('03-pending-download');
      await click(`[data-confirm="${record.id}"]`);
      uiResults.defaultModeNeedsOnlyConfirmation=true;
    }else {
      uiResults.askModeHasNoExtraConfirmation=await evaluate(`!document.querySelector('[data-confirm="${record.id}"]')`);
      const args=['-NoProfile','-File',resolve('scripts/handle-download-dialog.ps1'),'-TargetProcessId',String(child.pid)];
      args.push(...(cancelDialog?['-Cancel']:['-Destination',file]));
      const dialog=JSON.parse(execFileSync('powershell',args,{encoding:'utf8'}));
      uiResults.nativeSaveDialog=dialog.NativeDialogHandled;
    }
    if(cancel||cancelDialog){
      await waitFor(async()=>(await records()).find(r=>r.id===record.id)?.status==='cancelled');
      try{await access(file);throw new Error('Cancelled download unexpectedly created a file');}catch(error){if(error.code!=='ENOENT')throw error;}
      results.push({case:name,cancelled:true});
    }else{
      await waitFor(async()=>{try{return await readFile(file,'utf8')===body;}catch{return false;}});
      await waitFor(async()=>(await records()).find(r=>r.id===record.id)?.status==='completed');
      results.push({case:name,completed:true,file,id:record.id});
    }
  }
  const http=name=>`(()=>{const a=document.createElement('a');a.href='/api/dock-download/file/${name}?token=fixture';a.download='axiver-check-${stamp}-${name}.txt';document.body.appendChild(a);a.click();a.remove();})()`;
  await request('http',http('http'));
  const completePill=await pillMetrics();
  uiResults.pillAdaptsToText=completePill.width<initialPill.width&&Math.abs(completePill.width-completePill.expected)<1;
  async function progressCase(name,known){
    await remote('Runtime.evaluate',{expression:http(name),userGesture:false,awaitPromise:true});
    const record=await waitFor(async()=>(await records()).find(r=>r.name.includes(name)&&r.status==='pending'));
    await click(`[data-confirm="${record.id}"]`);
    const samples=[];let shot=false;let last;
    const deadline=Date.now()+25000;
    while(Date.now()<deadline){
      last=(await records()).find(r=>r.id===record.id);
      if(last.status==='completed')break;
      if(last.status==='failed')throw new Error(last.error);
      const dom=await evaluate(`(()=>{const card=document.querySelector('[data-id="${record.id}"]'),bar=card?.querySelector('.download-progress'),info=card?.querySelector('.download-transfer');return bar?{indeterminate:bar.classList.contains('indeterminate'),value:bar.getAttribute('aria-valuenow'),text:info.textContent,received:Number(info.dataset.received),speed:Number(info.dataset.speedBps),animation:getComputedStyle(bar.firstElementChild).animationName,transform:getComputedStyle(bar.firstElementChild).transform}:null;})()`);
      if(dom&&dom.received>0&&dom.speed>0){samples.push({received:last.received,total:last.total,speed:last.speedBps,dom});if(!shot){nativeShot(known?'05-known-progress-speed':'06-stream-progress-speed');shot=true;}}
      await pause(220);
    }
    if(last?.status!=='completed')throw new Error('Streaming download did not complete');
    const file=await readFile(last.path);
    const distinct=new Set(samples.map(s=>s.dom.received)).size;
    uiResults[name+'RealProgress']=distinct>=3&&file.equals(progressBody);
    uiResults[name+'RealSpeed']=samples.some(s=>s.dom.speed>1024&&s.dom.text.includes('/s'));
    uiResults[name+'ProgressMode']=known?samples.some(s=>s.total===progressBody.length&&Number(s.dom.value)>0&&Number(s.dom.value)<100&&!s.dom.indeterminate):samples.every(s=>s.total===null&&s.dom.value===null&&s.dom.indeterminate&&s.dom.animation==='download-stream');
    if(!known)uiResults.streamAnimationMoves=new Set(samples.map(s=>s.dom.transform)).size>=3;
    results.push({case:name,completed:true,samples,bytes:file.length});
  }
  await progressCase('progress-known',true);
  await progressCase('progress-stream',false);
  await switchMode('ask');
  await request('blob',`(()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([${JSON.stringify(body)}],{type:'application/octet-stream'}));a.download='axiver-check-${stamp}-blob.txt';document.body.appendChild(a);a.click();a.remove();})()`,{ask:true});
  await switchMode('default');
  await request('cancel',http('cancel'),{cancel:true});
  await switchMode('ask');
  await request('cancel-dialog',http('cancel-dialog'),{cancelDialog:true,ask:true});
  uiResults.modePersisted=JSON.parse(await readFile(join(root,'download-settings.json'),'utf8')).mode==='ask';
  if(await evaluate('document.getElementById("panel").hidden')){await click('#pill');await waitFor(()=>evaluate('!document.getElementById("panel").hidden'));}
  await click('#tab-downloads');
  uiResults.originalHttpRequestUsedOnce=requests.filter(url=>url==='/api/dock-download/file/http?token=fixture').length===1;
  await click(`[data-reveal="${results[0].id}"]`);
  await pause(200);
  uiResults.revealAccepted=await evaluate('!document.getElementById("download-feedback").textContent');
  const selectedRoot=await realpath(downloadDir);
  uiResults.actualSelectedDirectory=(await Promise.all((await records()).filter(r=>r.status==='completed').map(async r=>(await realpath(dirname(r.path)))===selectedRoot))).every(Boolean);
  const explorer=JSON.parse(execFileSync('powershell',['-NoProfile','-File',resolve('scripts/verify-download-reveal.ps1'),'-FolderPath',selectedRoot,'-FileName',basename(results[0].file)],{encoding:'utf8'}));
  uiResults.explorerSelectedExpectedFile=explorer.ExplorerSelectedExpectedFile;
  uiResults.recentListHasAllRecords=await evaluate('document.querySelectorAll(".download-card").length===6');
  uiResults.finalNative=nativeShot('04-recent-downloads');
  const report={exe,root,origin,requests,results,uiResults};
  await writeFile(join(artifacts,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({exe,artifacts,results:results.map(({samples,...result})=>({...result,...(samples?{progressSamples:samples.length}:{})})),uiResults},null,2));
  if(Object.values(uiResults).includes(false)||uiResults.native.VisibleNativeWindows!==1)process.exitCode=1;
} catch(error) {
  const failure={...await inspectFailure().catch(e=>({inspectionError:e.message})),childExit,childErrors};
  await writeFile(join(artifacts,'failure.json'),JSON.stringify(failure,null,2));
  console.log(JSON.stringify(failure,null,2));
  throw error;
} finally {
  sockets.forEach(ws=>ws.close());
  stopping=true;
  if(child.exitCode===null)execFileSync('taskkill',['/pid',String(child.pid),'/t','/f'],{stdio:'ignore',windowsHide:true});
  // These are only the exact, content-verified fixture files generated above.
  // Keep one reveal target while its Explorer window may be displaying it.
  server.closeAllConnections();server.close();
}
