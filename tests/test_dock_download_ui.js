const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../root/usr/share/selkies/selkies-dashboard/src/selkies-dock-download.js'), 'utf8');
let now = 0, nextTimer = 0, clicks = 0;
const timers = new Map();
const hint = {dataset: {}, hidden: true, textContent: '', appendChild() {}};
const label = {textContent: ''};
const shell = {dataset: {}, querySelector: () => label};
const context = vm.createContext({
  api: '/api/dock-download/', decorate: () => hint, seen: new Set(), notices: new Set(), notice: null,
  noticeTimer: undefined, dragSerial: 1, encodeURIComponent,
  setTimeout(callback, delay) { timers.set(++nextTimer, {at: now + delay, callback}); return nextTimer; },
  clearTimeout(id) { timers.delete(id); },
  document: {body: {appendChild() {}}, createElement() { return {click() { clicks++; }, remove() {}}; }}
});
const start = source.indexOf('  function showNotice(');
const end = source.indexOf('  async function tick(', start);
vm.runInContext(source.slice(start, end), context);
function render(state) { context.render(shell, state); }
function advance(ms) {
  now += ms;
  for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
}
const failure = {phase: 'error', error_id: 'failed-job', error: '文件目录未获下载授权 SELKIES_DROP_SOURCE_ROOTS',
  jobs: [{id: 'failed-job', state: 'error', error: '文件目录未获下载授权 SELKIES_DROP_SOURCE_ROOTS'}]};
render(failure);
assert(!hint.hidden);
assert(!hint.textContent.includes('SELKIES_'), 'Product notices must not show configuration names');
advance(3900); render(failure);
advance(101); render(failure);
assert(hint.hidden, 'Polling the same error must not renew its four-second timeout');
render({...failure, jobs: []});
assert(hint.hidden, 'Job cleanup must not revive the same retained backend error');
render({phase: 'target', jobs: failure.jobs});
assert.equal(label.textContent, '拖入以下载到本机');
assert(hint.hidden, 'The active bar replaces the floating tooltip');
render({phase: 'preparing'});
assert.equal(label.textContent, '正在准备下载…');
render({phase: 'idle'});
assert.equal(label.textContent, '', 'Cancel/leave restores ordinary bar contents');
const ready = {phase: 'idle', jobs: [{id: 'ready', state: 'ready', token: 'credential', name: 'file.gif'}]};
render(ready); render(ready);
assert.equal(clicks, 1, 'Repeated status polling must trigger only one attachment request');
advance(5001); render(ready);
assert(hint.hidden, 'Ready metadata must not keep download notices visible indefinitely');
assert.equal(clicks, 1);
render({phase: 'unsupported'});
assert(!hint.hidden);
advance(4001); render({phase: 'unsupported'});
assert(hint.hidden);
context.dragSerial++;
render({phase: 'unsupported'});
assert(!hint.hidden, 'A new drag may show a fresh short notice');
const conflict = {phase: 'error', error_id: 'conflict:1', error: '下载接收区正由另一个页面使用'};
render(conflict); advance(4001); render(conflict);
assert(hint.hidden, 'One drag conflict must not keep refreshing');
render({...conflict, error_id: 'conflict:2'});
assert(!hint.hidden, 'A later drag conflict must still get its own notice');
console.log('Dock UI: bounded notices, polling deduplication, active/preparing/cancel text and one-shot download passed');
