// Focused native WebView2 check, based on verify-downloads.mjs's disposable
// profile/CDP harness. Never opens the portable user's database or cookies.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, copyFile, readFile, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';

const exe = resolve(process.argv[2] || 'target/release/axiver-client.exe');
const artifacts = resolve(process.argv[3] || '../screenshots/parallel-frost');
const clickOnly = process.argv.includes('--click-only');
await mkdir(artifacts, {recursive:true});
const root = await mkdtemp(join(tmpdir(), 'axiver-frost-check-'));
const server = createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
  res.end('<!doctype html><style>body{margin:0;background:repeating-linear-gradient(100deg,#1872ad 0 36px,#f0a770 36px 72px);font:24px/1.7 sans-serif;color:white}p{margin:0}input{font:inherit}</style>' +
    Array.from({length:28}, (_, i) => `<p>AXIVER ${i} · 实际背景采样 · ABCDEFG</p>`).join('') + '<input id="remote-input">');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening');
const debugPort = portServer.address().port; await new Promise(r => portServer.close(r));
await copyFile(exe, join(root, 'AXIVER-Client.exe'));
execFileSync('python', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT)"); c.executemany("INSERT INTO settings VALUES(?,?)",[("broadcast_name","AXIVER-ISOLATED-FROST"),("wide_url",sys.argv[2])]); c.commit()', join(root, 'axiver-client.db'), origin]);
const child = spawn(join(root, 'AXIVER-Client.exe'), [], {env:{...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort}`}, windowsHide:true, stdio:'ignore'});
const sockets = [];
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeout=15000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { try { const result = await fn(); if(result) return result; } catch {} await pause(80); }
  throw new Error('Timed out waiting for focused native check');
}
async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl); await once(ws, 'open'); sockets.push(ws);
  const pending = new Map(); let nextId = 0;
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data), item = pending.get(msg.id);
    if(item) { pending.delete(msg.id); clearTimeout(item.timer); msg.error ? item.reject(msg.error) : item.resolve(msg.result); }
  });
  return (method, params={}) => new Promise((resolve,reject) => {
    const id = ++nextId, timer = setTimeout(() => {pending.delete(id); reject(new Error(method+' timed out'));}, 10000);
    pending.set(id,{resolve,reject,timer}); ws.send(JSON.stringify({id,method,params}));
  });
}
try {
  const targets = () => fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json());
  const shell = await connect(await waitFor(async () => (await targets()).find(t => t.url.endsWith('/shell.html'))));
  const evaluate = async expression => {
    const result = await shell('Runtime.evaluate', {expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await waitFor(() => evaluate('Boolean(window.__AXIVER_SHELL__?.layout)'));
  await waitFor(() => evaluate('window.__TAURI__.core.invoke("client_get_connection").then(r=>r.data.phase==="connected")'));
  const timing = (await readFile(join(root, 'axiver-client-data/connection-timing.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const selected = timing.find(e => e.event === 'target_selected');
  assert.equal(selected.detail, 'wan');
  assert(selected.elapsedMs < 1500, 'WAN was held behind LAN discovery');
  assert.equal(await evaluate('document.getElementById("pill-wan") === null'), true);
  const open = async () => {
    await evaluate('document.getElementById("pill").click()');
    await waitFor(() => evaluate('!document.getElementById("panel").hidden'));
  };
  const stats = async () => evaluate('window.__AXIVER_SHELL__.backdropStats');
  const collect = async duration => {
    await evaluate('window.__frames=[]; if(!window.__originalBackdrop){window.__originalBackdrop=window.__AXIVER_SHELL__.onBackdrop; window.__AXIVER_SHELL__.onBackdrop=frame=>{window.__frames.push(performance.now());return window.__originalBackdrop(frame);}}');
    await pause(duration);
    const frames = await evaluate('window.__frames');
    return {count:frames.length, fps:frames.length>1?(frames.length-1)*1000/(frames.at(-1)-frames[0]):0};
  };
  await waitFor(stats);
  const dot = clickOnly ? null : await collect(1800);
  await open(); await pause(600);
  const panel = clickOnly ? null : await collect(1800);
  if (!clickOnly) {
    assert(dot.fps > 1.5 && dot.fps < 2.5, JSON.stringify(dot));
    assert(panel.fps > 4.5 && panel.fps < 6.6, JSON.stringify(panel));
  }
  const processing = await stats();
  assert(processing.sampleWidth < 130 && processing.sampleHeight < 150, JSON.stringify(processing));
  assert.equal(await evaluate('getComputedStyle(document.getElementById("panel"),"::before").filter'), 'none');
  const native = JSON.parse(execFileSync('powershell', ['-NoProfile','-File',resolve('scripts/inspect-window.ps1'),'-TargetProcessId',String(child.pid),'-OutputPath',join(artifacts,'panel.png')], {encoding:'utf8'}));
  assert.equal(native.VisibleNativeWindows, 1);
  // Transparent area inside the shell, outside both interactive surfaces.
  await evaluate('document.body.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
  await waitFor(() => evaluate('document.getElementById("panel").hidden'));
  assert.equal(await evaluate('document.getElementById("pill").classList.contains("collapsed")'), false);
  await waitFor(() => evaluate('document.getElementById("pill").classList.contains("collapsed") && !document.getElementById("pill").classList.contains("animating")'));
  // Focus changes and actual inside presses must leave the panel open.
  await open(); await pause(350);
  await evaluate('window.__nativeOutsideCount=0; const original=window.__AXIVER_SHELL__.onOutside; window.__AXIVER_SHELL__.onOutside=()=>{window.__nativeOutsideCount++;return original();}');
  await evaluate('window.dispatchEvent(new Event("blur")); document.getElementById("tab-settings").click(); document.getElementById("connection-settings").open=true; document.getElementById("broadcast-name").focus()');
  await pause(350);
  assert.equal(await evaluate('document.getElementById("panel").hidden'), false, 'inside focus/tab change dismissed the panel');
  const hostHandle = native.Windows.find(w => w.Class === 'Tauri Window').Handle;
  const nativeApi = `
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices; using System.Threading;
public class FixtureFocus {
  public delegate bool EnumProc(IntPtr h,IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect {public int L,T,R,B;}
  [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,EnumProc f,IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out Rect r);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder s,int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a,uint b,bool attach);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref Point p);
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h,uint flags);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
  public static long Remote(long host) {
    IntPtr target=IntPtr.Zero;
    EnumChildWindows(new IntPtr(host),(h,p)=>{var s=new StringBuilder(128);GetClassName(h,s,128);Rect r;GetClientRect(h,out r);
      if(IsWindowVisible(h)&&s.ToString()=="Chrome_RenderWidgetHostHWND"&&r.R-r.L>700&&r.B-r.T>500)target=h;return true;},IntPtr.Zero);
    if(target==IntPtr.Zero)throw new Exception("Remote renderer HWND not found");
    uint pid;uint other=GetWindowThreadProcessId(target,out pid),current=GetCurrentThreadId();
    if(!AttachThreadInput(current,other,true))throw new Exception("AttachThreadInput failed");
    try{SetFocus(target);}finally{AttachThreadInput(current,other,false);}return target.ToInt64();
  }
  public static void Click(long host,double x,double y) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    var window=new IntPtr(host);var previous=GetForegroundWindow();Point cursor;GetCursorPos(out cursor);
    try {
      SetForegroundWindow(window);Thread.Sleep(100);
      var scale=GetDpiForWindow(window)/96.0;
      var point=new Point{X=(int)Math.Round(x*scale),Y=(int)Math.Round(y*scale)};
      ClientToScreen(window,ref point);
      // Never send input when another window covers the fixture point.
      if(GetAncestor(WindowFromPoint(point),2)!=window)throw new Exception("Fixture point obscured; refused to click another app");
      SetCursorPos(point.X,point.Y);mouse_event(2,0,0,0,UIntPtr.Zero);mouse_event(4,0,0,0,UIntPtr.Zero);
    } finally {
      SetCursorPos(cursor.X,cursor.Y);
      if(GetForegroundWindow()==window&&previous!=IntPtr.Zero)SetForegroundWindow(previous);
    }
  }
}
'@
`;
  const nativeCall = expression => execFileSync('powershell',['-NoProfile','-Command',nativeApi+expression],{encoding:'utf8'}).trim();
  const nativeFocus = nativeCall(`[FixtureFocus]::Remote(${hostHandle})`);
  await pause(350);
  assert.equal(await evaluate('document.getElementById("panel").hidden'), false, 'native focus change alone dismissed the panel');
  const inside = await evaluate('(()=>{const l=window.__AXIVER_SHELL__.layout; return {x:l.viewX+l.panelX+60,y:l.viewY+l.panelY+22};})()');
  nativeCall(`[FixtureFocus]::Click(${hostHandle},${inside.x},${inside.y})`);
  await pause(350);
  assert.equal(await evaluate('document.getElementById("panel").hidden'), false, 'actual inside click dismissed the panel');
  assert.equal(await evaluate('window.__nativeOutsideCount'), 0);
  nativeCall(`[FixtureFocus]::Click(${hostHandle},800,500)`);
  await waitFor(() => evaluate('document.getElementById("panel").hidden'));
  assert(await evaluate('window.__nativeOutsideCount > 0'), 'actual outside press was not detected');
  await waitFor(() => evaluate('document.getElementById("pill").classList.contains("collapsed")'));
  const result = {scope:'disposable native WebView2; actual inside/outside presses and focus-only retention; no real user profile', root, selected, timing, dot, panel, processing, native, nativeFocus};
  await writeFile(join(artifacts,'results.json'), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {
  for(const ws of sockets) ws.close();
  child.kill(); server.closeAllConnections(); server.close();
}
