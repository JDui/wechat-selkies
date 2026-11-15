// Exercise the shipped worklet with silent and audible PCM, without audio devices.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');
const bundle = fs.readFileSync(path.join(__dirname, '../root/usr/share/selkies/selkies-dashboard/assets/index-CzFxBFXa.js'), 'utf8');
const start = bundle.indexOf('class AudioFrameProcessor extends AudioWorkletProcessor');
const end = bundle.indexOf("registerProcessor('audio-frame-processor', AudioFrameProcessor);", start);
assert(start > 0 && end > start);
const reports = [];
const context = {currentTime: 0, sampleRate: 48000, Float32Array,
  AudioWorkletProcessor: class { constructor() { this.port = {postMessage: m => reports.push(m)}; } },
  registerProcessor: (_, Processor) => { context.processor = new Processor(); }};
vm.createContext(context);
vm.runInContext(bundle.slice(start, end) + "registerProcessor('test', AudioFrameProcessor);", context);
const send = data => context.processor.port.onmessage({data});
send({audioData: new Float32Array(1920).buffer});
send({type: 'getBufferSize'});
assert(reports.at(-1).size > 0);
assert.strictEqual(reports.at(-1).active, false, 'buffered silence must not keep video active');
const sound = new Float32Array(1920); sound[51] = 0.02;
context.currentTime = 1;
send({audioData: sound.buffer});
send({type: 'getBufferSize'});
assert.strictEqual(reports.at(-1).active, true, 'notification sound is detected');
assert.strictEqual(context.processor.audioBufferQueue.at(-1)[51], sound[51], 'audio remains unchanged');
context.currentTime = 2;
send({audioData: new Float32Array(1920).buffer});
send({type: 'getBufferSize'});
assert.strictEqual(reports.at(-1).active, false, 'activity expires after sound ends');
const source = fs.readFileSync(path.join(__dirname, '../root/usr/share/selkies/selkies-dashboard/src/selkies-runtime-overrides.js'), 'utf8');
const helperStart = source.indexOf('  function isRemoteAudioPlaying()');
const helperEnd = source.indexOf('  function ', helperStart + 1);
Object.assign(context, {window: {selkiesRemoteAudioActive: true, selkiesRemoteAudioActivityAt: 1000}, Date: {now: () => 1200}});
vm.runInContext(source.slice(helperStart, helperEnd), context);
assert(context.isRemoteAudioPlaying());
context.Date.now = () => 3000;
assert(!context.isRemoteAudioPlaying(), 'stale worklet updates cannot pin full FPS');
console.log('silent PCM / notification sound / activity expiry checks passed');
