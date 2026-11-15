// Event-order regression checks; no native IME or remote chat is simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../ui/remote-compat/ime-guard.js'), 'utf8');

function fixture({ modern = false, transport = true } = {}) {
  const listeners = new Map(), timers = new Map(), sent = [];
  let timerId = 0;
  function target(extra = {}) {
    const obj = { ...extra, addEventListener(type, fn, capture = false) {
      const key = obj === window ? 'window' : obj === document ? 'document' : 'assist';
      const id = `${key}:${type}:${!!capture}`;
      if (!listeners.has(id)) listeners.set(id, []);
      listeners.get(id).push(fn);
    } };
    return obj;
  }
  const window = target({
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  });
  window.self = window.top = window;
  const assist = target({ id: 'keyboard-input-assist', value: '' });
  const document = target({ readyState: 'complete', getElementById: () => assist });
  const input = { send: packet => sent.push(packet), _typeString: text => sent.push('co,end,' + text) };
  if (transport) window.webrtcInput = input;
  if (modern) window.selkiesRecoverPendingInput = () => '';
  const context = vm.createContext({ window, document, location: { protocol: 'https:' },
    clearTimeout: window.clearTimeout, MutationObserver: class { observe() {} disconnect() {} } });
  vm.runInContext(source, context);
  // Legacy window capture listener runs before element capture listeners.
  window.addEventListener('keydown', e => {
    if (e.key === 'Enter') { sent.push('kd,65293'); assist.value = ''; }
    else sent.push('key,' + e.key);
    e.preventDefault();
  }, true);
  window.addEventListener('keyup', e => sent.push('up,' + e.key), true);
  assist.addEventListener('input', () => {
    if (assist.value) input._typeString(assist.value);
    assist.value = '';
  });
  function event(type, props = {}) {
    const e = { target: assist, stopped: false, prevented: false,
      stopImmediatePropagation() { this.stopped = true; },
      preventDefault() { this.prevented = true; }, ...props };
    for (const phase of ['window:true', 'document:true', 'assist:true', 'assist:false', 'document:false', 'window:false']) {
      const [where, capture] = phase.split(':');
      for (const fn of listeners.get(`${where}:${type}:${capture}`) || []) {
        fn(e); if (e.stopped) return e;
      }
    }
    return e;
  }
  function commit(text) { event('compositionstart'); assist.value = text; event('compositionend', { data: text }); }
  function tick() { const batch = [...timers.values()]; timers.clear(); batch.forEach(fn => fn()); }
  return { window, assist, sent, event, commit, tick, input };
}

const checks = {
  'quick Enter cannot overtake the committed word'() {
    const f = fixture(); f.commit('完整消息'); f.event('keydown', { key: 'Enter', code: 'Enter' }); f.tick();
    assert.deepEqual(f.sent, ['co,end,完整消息', 'kd,65293']);
  },
  'two compositions before timers preserve both words'() {
    const f = fixture(); f.commit('第一词'); f.commit('第二词'); f.tick();
    assert.deepEqual(f.sent, ['co,end,第一词', 'co,end,第二词']);
  },
  'candidate Enter stays native including its release'() {
    const f = fixture(); f.event('compositionstart');
    const down = f.event('keydown', { key: 'Enter', code: 'Enter' });
    assert.equal(down.prevented, false); assert.equal(down.stopped, true);
    f.assist.value = '中文'; f.event('compositionend', { data: '中文' });
    assert.equal(f.event('keyup', { key: 'Enter', code: 'Enter' }).stopped, true);
    f.event('keydown', { key: 'Enter', code: 'Enter' });
    assert.deepEqual(f.sent, ['co,end,中文', 'kd,65293']);
  },
  'empty DOM and trailing input deliver exactly once'() {
    const f = fixture(); f.event('compositionstart'); f.event('compositionend', { data: '中文😀' });
    f.assist.value = '中文😀'; f.event('input', { data: '中文😀', inputType: 'insertFromComposition' }); f.tick();
    assert.deepEqual(f.sent, ['co,end,中文😀']);
  },
  'cancel and blur never send unfinished pinyin'() {
    const f = fixture(); f.event('compositionstart'); f.assist.value = 'pinyin';
    f.event('compositionend', { data: '' }); f.tick();
    f.event('compositionstart'); f.assist.value = 'pinyin'; f.event('blur'); f.tick();
    assert.deepEqual(f.sent, []);
  },
  'pending text blocks Enter until a transport exists'() {
    const f = fixture({ transport: false }); f.commit('保留');
    assert.equal(f.event('keydown', { key: 'Enter' }).prevented, true);
    assert.deepEqual(f.sent, []);
    f.window.webrtcInput = f.input; f.event('keydown', { key: 'Enter' });
    assert.deepEqual(f.sent, ['co,end,保留', 'kd,65293']);
  },
  'ordinary input and repeated same-word commits are retained'() {
    const f = fixture(); f.commit('好'); f.tick(); f.commit('好'); f.tick();
    f.event('keydown', { key: 'a' }); f.assist.value = 'a'; f.event('input', { data: 'a', inputType: 'insertText' });
    assert.deepEqual(f.sent, ['co,end,好', 'co,end,好', 'key,a', 'co,end,a']);
  },
  'modern server guard owns events without a second client sender'() {
    const f = fixture({ modern: true }); f.commit('服务端处理'); f.tick();
    assert.deepEqual(f.sent, []);
    assert.equal(f.event('compositionstart').stopped, false);
  },
};
let failed = 0;
for (const [name, check] of Object.entries(checks)) {
  try { check(); console.log('PASS', name); }
  catch (error) { failed++; console.error('FAIL', name, error.message); }
}
if (failed) process.exitCode = 1;
