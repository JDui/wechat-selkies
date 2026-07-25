"use strict";

var DB_NAME = "selkies-upload-v1";
var STORE_NAME = "tasks";
var CHANNEL_NAME = "selkies-upload-v1";
var channel = new BroadcastChannel(CHANNEL_NAME);
var tasks = new Map();
var tokenState = null;
var schedulerRunning = false;
var MAX_RETRIES = 4;

function api(path) {
  return "../upload-api/v1/" + path;
}

function openDatabase() {
  return new Promise(function (resolve, reject) {
    var request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = function () {
      request.result.createObjectStore(STORE_NAME, { keyPath: "localId" });
    };
    request.onsuccess = function () { resolve(request.result); };
    request.onerror = function () { reject(request.error); };
  });
}

async function withStore(mode, callback) {
  var db = await openDatabase();
  return new Promise(function (resolve, reject) {
    var tx = db.transaction(STORE_NAME, mode);
    var result;
    try { result = callback(tx.objectStore(STORE_NAME)); } catch (error) { reject(error); return; }
    tx.oncomplete = function () { resolve(result); db.close(); };
    tx.onerror = function () { reject(tx.error); db.close(); };
  });
}

function persistedTask(task) {
  return {
    localId: task.localId,
    sessionId: task.sessionId || null,
    fileName: task.fileName,
    size: task.size,
    lastModified: task.lastModified || 0,
    uploadedBytes: task.uploadedBytes || 0,
    uploadedChunks: task.uploadedChunks || [],
    chunkSize: task.chunkSize || 0,
    status: task.status === "complete" ? "complete" : "needs-file",
    createdAt: task.createdAt
  };
}

async function saveTask(task) {
  await withStore("readwrite", function (store) { store.put(persistedTask(task)); });
}

async function removeTask(localId) {
  await withStore("readwrite", function (store) { store.delete(localId); });
}

function publish(task) {
  var snapshot = {
    localId: task.localId,
    sessionId: task.sessionId || null,
    fileName: task.fileName,
    size: task.size,
    uploadedBytes: task.uploadedBytes || 0,
    speedBytesPerSecond: Math.round(task.speedBytesPerSecond || 0),
    status: task.status,
    error: task.error || ""
  };
  postMessage({ type: "task", task: snapshot });
  channel.postMessage({ type: "upload-summary", task: snapshot });
}

async function getToken(force) {
  var now = Math.floor(Date.now() / 1000);
  if (!force && tokenState && tokenState.expires_at > now + 20) return tokenState.token;
  var response = await fetch(api("token"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  if (!response.ok) throw new Error("上传鉴权失败（HTTP " + response.status + "）");
  tokenState = await response.json();
  return tokenState.token;
}

async function authorizedFetch(url, options, retryAuth) {
  var token = await getToken(false);
  var headers = new Headers(options.headers || {});
  headers.set("Authorization", "Bearer " + token);
  options.headers = headers;
  options.credentials = "same-origin";
  var response = await fetch(url, options);
  if (response.status === 401 && retryAuth !== false) {
    token = await getToken(true);
    headers.set("Authorization", "Bearer " + token);
    response = await fetch(url, options);
  }
  return response;
}

async function createRemoteSession(task) {
  task.status = "creating";
  publish(task);
  var response = await authorizedFetch(api("sessions"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_name: task.fileName, size: task.size })
  });
  if (!response.ok) throw await responseError(response);
  var remote = await response.json();
  task.sessionId = remote.id;
  task.chunkSize = remote.chunk_size;
  task.uploadedBytes = remote.uploaded_bytes || 0;
  task.uploadedChunks = remote.uploaded_chunks || [];
  await saveTask(task);
}

async function refreshRemoteSession(task) {
  if (!task.sessionId) return false;
  var response = await authorizedFetch(api("sessions/" + task.sessionId), { method: "GET" });
  if (response.status === 404) {
    task.sessionId = null;
    return false;
  }
  if (!response.ok) throw await responseError(response);
  var remote = await response.json();
  task.chunkSize = remote.chunk_size;
  task.uploadedBytes = remote.uploaded_bytes || 0;
  task.uploadedChunks = remote.uploaded_chunks || [];
  return true;
}

async function responseError(response) {
  var payload = {};
  try { payload = await response.json(); } catch (_) {}
  return new Error(payload.message || payload.error || ("HTTP " + response.status));
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

async function uploadChunk(task, index) {
  var start = index * task.chunkSize;
  var end = Math.min(task.size, start + task.chunkSize);
  var attempt = 0;
  while (attempt < MAX_RETRIES) {
    if (task.status === "paused" || task.status === "cancelled") throw new DOMException("Aborted", "AbortError");
    var controller = new AbortController();
    task.controllers.add(controller);
    try {
      var response = await authorizedFetch(api("sessions/" + task.sessionId + "/chunks/" + index), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: task.file.slice(start, end),
        signal: controller.signal
      });
      if (!response.ok) throw await responseError(response);
      var remote = await response.json();
      var previous = task.uploadedBytes;
      task.uploadedBytes = remote.uploaded_bytes;
      task.uploadedChunks = remote.uploaded_chunks;
      updateSpeed(task, task.uploadedBytes - previous);
      await saveTask(task);
      publish(task);
      return;
    } catch (error) {
      if (error && error.name === "AbortError") throw error;
      attempt += 1;
      if (attempt >= MAX_RETRIES) throw error;
      task.status = "retrying";
      task.error = "分片重试 " + attempt + "/" + MAX_RETRIES;
      publish(task);
      await sleep(Math.min(8000, 500 * Math.pow(2, attempt - 1)));
      task.status = "uploading";
      task.error = "";
    } finally {
      task.controllers.delete(controller);
    }
  }
}

function updateSpeed(task, addedBytes) {
  var now = performance.now();
  var elapsed = Math.max(1, now - task.speedAt);
  task.speedBytes += Math.max(0, addedBytes);
  if (elapsed >= 700) {
    var instant = task.speedBytes * 1000 / elapsed;
    task.speedBytesPerSecond = task.speedBytesPerSecond
      ? task.speedBytesPerSecond * 0.65 + instant * 0.35
      : instant;
    task.speedBytes = 0;
    task.speedAt = now;
  }
}

async function uploadMissingChunks(task) {
  var total = Math.ceil(task.size / task.chunkSize);
  var uploaded = new Set(task.uploadedChunks || []);
  var indices = [];
  for (var index = 0; index < total; index += 1) {
    if (!uploaded.has(index)) indices.push(index);
  }
  var concurrency = Math.max(1, Math.min(6, Number(tokenState && tokenState.max_concurrency) || 3));
  var cursor = 0;
  async function runner() {
    while (cursor < indices.length) {
      var current = indices[cursor++];
      await uploadChunk(task, current);
    }
  }
  var runners = [];
  for (var count = 0; count < Math.min(concurrency, indices.length); count += 1) runners.push(runner());
  await Promise.all(runners);
}

async function runTask(task) {
  if (!task.file || task.status === "paused" || task.status === "cancelled" || task.status === "complete") return;
  task.error = "";
  task.controllers = task.controllers || new Set();
  task.speedAt = performance.now();
  task.speedBytes = 0;
  try {
    if (!task.sessionId) await createRemoteSession(task);
    else if (!(await refreshRemoteSession(task))) await createRemoteSession(task);
    task.status = "uploading";
    publish(task);
    await uploadMissingChunks(task);
    if (task.status === "paused" || task.status === "cancelled") return;
    task.status = "completing";
    publish(task);
    var response = await authorizedFetch(api("sessions/" + task.sessionId + "/complete"), { method: "POST" });
    if (!response.ok) throw await responseError(response);
    var remote = await response.json();
    task.uploadedBytes = remote.uploaded_bytes;
    task.status = "complete";
    task.speedBytesPerSecond = 0;
    await saveTask(task);
    publish(task);
  } catch (error) {
    if (error && error.name === "AbortError" && (task.status === "paused" || task.status === "cancelled")) return;
    task.status = "error";
    task.error = String((error && error.message) || error || "上传失败");
    await saveTask(task);
    publish(task);
  }
}

async function schedule() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    while (true) {
      var next = Array.from(tasks.values()).find(function (task) { return task.status === "queued"; });
      if (!next) break;
      await runTask(next);
    }
  } finally {
    schedulerRunning = false;
  }
}

function makeTask(file, existing) {
  return {
    localId: existing ? existing.localId : crypto.randomUUID(),
    sessionId: existing ? existing.sessionId : null,
    fileName: file.webkitRelativePath || file.name,
    size: file.size,
    lastModified: file.lastModified || 0,
    file: file,
    chunkSize: existing ? existing.chunkSize : 0,
    uploadedBytes: existing ? existing.uploadedBytes : 0,
    uploadedChunks: existing ? existing.uploadedChunks : [],
    status: "queued",
    error: "",
    createdAt: existing ? existing.createdAt : Date.now(),
    speedAt: performance.now(),
    speedBytes: 0,
    speedBytesPerSecond: 0,
    controllers: new Set()
  };
}

async function addFiles(files) {
  for (var file of files) {
    var existing = Array.from(tasks.values()).find(function (task) {
      return task.status === "needs-file"
        && task.fileName === (file.webkitRelativePath || file.name)
        && task.size === file.size
        && (!task.lastModified || task.lastModified === file.lastModified);
    });
    if (existing) tasks.delete(existing.localId);
    var task = makeTask(file, existing);
    tasks.set(task.localId, task);
    await saveTask(task);
    publish(task);
  }
  schedule();
}

async function cancelTask(task) {
  task.status = "cancelled";
  task.controllers.forEach(function (controller) { controller.abort(); });
  if (task.sessionId) {
    try { await authorizedFetch(api("sessions/" + task.sessionId), { method: "DELETE" }); } catch (_) {}
  }
  await removeTask(task.localId);
  publish(task);
}

async function restoreTasks() {
  var db = await openDatabase();
  var records = await new Promise(function (resolve, reject) {
    var tx = db.transaction(STORE_NAME, "readonly");
    var request = tx.objectStore(STORE_NAME).getAll();
    request.onsuccess = function () { resolve(request.result || []); };
    request.onerror = function () { reject(request.error); };
  });
  db.close();
  records.forEach(function (record) {
    record.file = null;
    record.status = record.status === "complete" ? "complete" : "needs-file";
    record.controllers = new Set();
    record.speedBytesPerSecond = 0;
    tasks.set(record.localId, record);
    publish(record);
  });
}

onmessage = async function (event) {
  var message = event.data || {};
  if (message.type === "init") {
    try {
      await getToken(false);
      await restoreTasks();
      postMessage({ type: "ready" });
    } catch (error) {
      postMessage({ type: "service-error", error: String(error && error.message || error) });
    }
    return;
  }
  if (message.type === "add-files") {
    await addFiles(message.files || []);
    return;
  }
  if (message.type === "retry-all") {
    tasks.forEach(function (task) {
      if (task.status === "error" && task.file) task.status = "queued";
    });
    schedule();
    return;
  }
  if (message.type === "clear-finished") {
    for (var task of Array.from(tasks.values())) {
      if (task.status === "complete" || task.status === "cancelled") {
        tasks.delete(task.localId);
        await removeTask(task.localId);
        postMessage({ type: "remove", localId: task.localId });
      }
    }
    return;
  }
  var task = tasks.get(message.localId);
  if (!task) return;
  if (message.type === "pause") {
    task.status = "paused";
    task.controllers.forEach(function (controller) { controller.abort(); });
    await saveTask(task);
    publish(task);
  } else if (message.type === "resume" && task.file) {
    task.status = "queued";
    await saveTask(task);
    publish(task);
    schedule();
  } else if (message.type === "retry" && task.file) {
    task.status = "queued";
    task.error = "";
    publish(task);
    schedule();
  } else if (message.type === "cancel") {
    await cancelTask(task);
  }
};

setInterval(function () {
  var values = Array.from(tasks.values());
  var activeRequests = 0;
  values.forEach(function (task) {
    activeRequests += task.controllers ? task.controllers.size : 0;
  });
  channel.postMessage({
    type: "worker-diagnostics",
    metrics: {
      taskCount: values.length,
      queuedTasks: values.filter(function (task) { return task.status === "queued"; }).length,
      activeRequests: activeRequests,
      pausedTasks: values.filter(function (task) { return task.status === "paused"; }).length
    }
  });
}, 5000);
