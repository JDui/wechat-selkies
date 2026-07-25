(function () {
  "use strict";

  var worker = new Worker("upload-worker.js");
  var channel = new BroadcastChannel("selkies-upload-v1");
  var tasks = new Map();
  var seenTransfers = new Set();
  var list = document.getElementById("task-list");
  var template = document.getElementById("task-template");
  var fileInput = document.getElementById("file-input");
  var dropZone = document.getElementById("drop-zone");
  var summary = document.getElementById("queue-summary");
  var resumeHint = document.getElementById("resume-hint");
  var serviceStatus = document.getElementById("service-status");

  function formatBytes(bytes) {
    var value = Number(bytes) || 0;
    var units = ["B", "KB", "MB", "GB", "TB"];
    var index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    return value.toFixed(index ? 1 : 0) + " " + units[index];
  }

  function statusLabel(status) {
    return {
      queued: "等待上传",
      creating: "创建任务",
      uploading: "上传中",
      paused: "已暂停",
      retrying: "正在重试",
      completing: "正在校验",
      complete: "已完成",
      error: "失败",
      cancelled: "已取消",
      "needs-file": "等待重新选择文件"
    }[status] || status;
  }

  function renderTask(task) {
    var node = document.querySelector('[data-task-id="' + task.localId + '"]');
    if (!node) {
      node = template.content.firstElementChild.cloneNode(true);
      node.dataset.taskId = task.localId;
      list.appendChild(node);
    }
    node.querySelector(".task-name").textContent = task.fileName;
    node.querySelector(".task-status").textContent = statusLabel(task.status);
    var progress = task.size ? Math.min(100, (task.uploadedBytes / task.size) * 100) : 0;
    node.querySelector(".progress-bar").style.width = progress.toFixed(2) + "%";
    var meta = formatBytes(task.uploadedBytes) + " / " + formatBytes(task.size);
    if (task.speedBytesPerSecond) meta += " · " + formatBytes(task.speedBytesPerSecond) + "/s";
    if (task.error) meta += " · " + task.error;
    node.querySelector(".task-meta").textContent = meta;
    node.querySelector('[data-action="pause"]').disabled = task.status !== "uploading" && task.status !== "retrying";
    node.querySelector('[data-action="resume"]').disabled = task.status !== "paused";
    node.querySelector('[data-action="retry"]').disabled = task.status !== "error";
    node.querySelector('[data-action="cancel"]').disabled = task.status === "complete" || task.status === "cancelled";
  }

  function renderSummary() {
    var values = Array.from(tasks.values());
    var active = values.filter(function (task) {
      return ["creating", "uploading", "retrying", "completing"].indexOf(task.status) >= 0;
    }).length;
    var done = values.filter(function (task) { return task.status === "complete"; }).length;
    summary.textContent = values.length ? values.length + " 项 · " + active + " 项上传中 · " + done + " 项完成" : "队列为空";
    resumeHint.hidden = !values.some(function (task) { return task.status === "needs-file"; });
  }

  function addFiles(files) {
    var list = Array.from(files || []);
    if (!list.length) return;
    worker.postMessage({ type: "add-files", files: list });
    fileInput.value = "";
  }

  worker.onmessage = function (event) {
    var message = event.data || {};
    if (message.type === "ready") {
      serviceStatus.textContent = "上传服务可用";
      serviceStatus.className = "service-status ok";
      return;
    }
    if (message.type === "service-error") {
      serviceStatus.textContent = "上传服务不可用";
      serviceStatus.className = "service-status error";
      return;
    }
    if (message.type === "task" && message.task) {
      tasks.set(message.task.localId, message.task);
      renderTask(message.task);
      renderSummary();
    }
    if (message.type === "remove") {
      tasks.delete(message.localId);
      var node = document.querySelector('[data-task-id="' + message.localId + '"]');
      if (node) node.remove();
      renderSummary();
    }
  };

  channel.onmessage = function (event) {
    var message = event.data || {};
    if (message.type !== "enqueue-files" || !message.files || seenTransfers.has(message.transferId)) return;
    seenTransfers.add(message.transferId);
    addFiles(message.files);
    window.focus();
  };
  channel.postMessage({ type: "uploader-ready" });

  dropZone.addEventListener("click", function () { fileInput.click(); });
  dropZone.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", function () { addFiles(fileInput.files); });
  ["dragenter", "dragover"].forEach(function (name) {
    dropZone.addEventListener(name, function (event) {
      event.preventDefault();
      dropZone.classList.add("dragging");
    });
  });
  ["dragleave", "drop"].forEach(function (name) {
    dropZone.addEventListener(name, function (event) {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    });
  });
  dropZone.addEventListener("drop", function (event) { addFiles(event.dataTransfer.files); });

  list.addEventListener("click", function (event) {
    var button = event.target.closest("button[data-action]");
    var taskNode = event.target.closest("[data-task-id]");
    if (!button || !taskNode) return;
    worker.postMessage({
      type: button.dataset.action,
      localId: taskNode.dataset.taskId
    });
  });

  document.getElementById("retry-all").addEventListener("click", function () {
    worker.postMessage({ type: "retry-all" });
  });
  document.getElementById("clear-finished").addEventListener("click", function () {
    worker.postMessage({ type: "clear-finished" });
  });

  worker.postMessage({ type: "init" });
}());
