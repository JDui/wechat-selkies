/*
 * AXIVER Shell — the only trusted local UI.
 *
 * It talks to Rust exclusively through typed IPC commands (spec 5.2).
 * There is no pseudo-navigation and no remote-page injection involved.
 * "Saved" is shown only after the real SQLite transaction succeeded.
 */
(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  const listen = window.__TAURI__?.event?.listen;

  const $ = (id) => document.getElementById(id);
  const statusDot = $("status-dot");
  const statusText = $("status-text");
  const statusTarget = $("status-target");
  const statusTime = $("status-time");
  const statusError = $("status-error");
  const btnDetails = $("btn-details");
  const detailsBox = $("status-details");
  const detailsList = $("details-list");
  const btnCopyDiag = $("btn-copy-diag");
  const copyResult = $("copy-result");
  const btnRefresh = $("btn-refresh");
  const btnReconnect = $("btn-reconnect");
  const opStatus = $("op-status");
  const broadcastInput = $("broadcast-name");
  const wideInput = $("wide-url");
  const broadcastError = $("broadcast-error");
  const wideError = $("wide-error");
  const btnSave = $("btn-save");
  const btnCancel = $("btn-cancel");
  const saveStatus = $("save-status");
  const versionEl = $("version");
  const dbWarning = $("db-warning");
  const btnPin = $("btn-pin");
  const btnHide = $("btn-hide");

  let lastSnapshot = null;
  let lastRevision = -1;
  let config = null;
  let editingDirty = false;
  let saving = false;
  let opBusy = null;
  let pinned = false;
  let bootRetries = 0;
  let activeTab = "connection";
  let downloadNotice = null;
  let noticeTimer;
  let drag = null;
  let suppressClickUntil = 0;
  let moveTail = Promise.resolve();
  let downloads = [];
  let downloadSettings=null;
  function renderDownloadSettings(settings) {
    if(!settings)return;downloadSettings=settings;
    $("download-mode-default").checked=settings.mode==="default";
    $("download-mode-ask").checked=settings.mode==="ask";
    $("download-directory").textContent=settings.directory||"请选择默认下载目录";
    $("download-directory").title=settings.directory||"";
    $("default-download-location").hidden=settings.mode==="ask";
    $("download-mode-hint").textContent=settings.mode==="ask"?"直接选择保存位置，不再额外确认；取消即放弃下载。":"先确认是否下载，再保存到默认目录；取消即放弃。";
  }
  for(const id of ["download-mode-default","download-mode-ask"]){
    $(id).addEventListener("change",async()=>{
      const result=await call("client_set_download_mode",{mode:$(id).value},null);
      if(result?.ok){renderDownloadSettings(result.data);$("download-settings-result").textContent="已保存，将用于后续新任务";}
      else{renderDownloadSettings(downloadSettings);$("download-settings-result").textContent=result?.error?.message||"设置未保存";}
    });
  }
  $("btn-download-directory").addEventListener("click",async()=>{
    const result=await call("client_choose_download_directory",undefined,null);
    if(result?.ok)renderDownloadSettings(result.data);
    else $("download-settings-result").textContent=result?.error?.message||"目录未修改";
  });
  const knownRequests = new Set();
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let backdrop = null;
  let frameSequence = 0;
  let closeAnimation = false;
  function animate(element, keyframes, options = {}) {
    if (motion.matches) return null;
    return element.animate(keyframes, {duration: 240, easing: "cubic-bezier(.2,.8,.2,1)", ...options});
  }
  function materialOffsets(layout) {
    if (!layout || !backdrop) return;
    for (const [id,x,y] of [["pill",layout.viewX+layout.pillX,layout.viewY+layout.pillY],["panel",layout.viewX+layout.panelX,layout.viewY+layout.panelY]]) {
      const surface=$(id);
      surface.style.setProperty("--sample-x", (-x+18)+"px");
      surface.style.setProperty("--sample-y", (-y+18)+"px");
    }
  }
  async function renderBackdrop(frame) {
    const sequence=++frameSequence;
    const image=new Image(); image.src=frame.src;
    try { await image.decode(); } catch { return; }
    if (sequence!==frameSequence) return;
    backdrop=frame;
    const root=document.documentElement;
    root.style.setProperty("--backdrop", `url("${frame.src}")`);
    root.style.setProperty("--backdrop-size", `${frame.width}px ${frame.height}px`);
    root.classList.add("has-backdrop");
    materialOffsets(window.__AXIVER_SHELL__.layout);
  }
  function sizeText(bytes) {
    if (bytes == null) return "大小待确认";
    const unit=Math.min(3,Math.floor(Math.log2(Math.max(1,bytes))/10));
    return (bytes/1024**unit).toFixed(unit?1:0)+[" B"," KB"," MB"," GB"][unit];
  }
  function updateProgress(card,record) {
    const bar=card.querySelector(".download-progress");if(!bar)return;
    const known=record.total>0;
    const percent=known?Math.min(100,record.received/record.total*100):null;
    bar.classList.toggle("indeterminate",!known);
    bar.setAttribute("aria-valuetext",known?`${percent.toFixed(1)}%，已下载 ${sizeText(record.received)}`:`已下载 ${sizeText(record.received)}，总大小未知`);
    if(known){bar.setAttribute("aria-valuenow",percent.toFixed(1));bar.firstElementChild.style.width=percent+"%";}
    else{bar.removeAttribute("aria-valuenow");bar.firstElementChild.style.removeProperty("width");}
    card.querySelector(".download-meta").textContent=known?`正在下载 · ${Math.floor(percent)}%`:"正在下载 · 总大小未知";
    const info=card.querySelector(".download-transfer");
    info.textContent=`${sizeText(record.received)}${known?" / "+sizeText(record.total):""} · ${sizeText(record.speedBps||0)}/s`;
    info.dataset.received=String(record.received);info.dataset.speedBps=String(record.speedBps||0);
  }
  function renderDownloads(records) {
    const previous=new Map(downloads.map(record=>[record.id,record.status]));
    downloads=records;
    const list=$("download-list");
    const existing=new Map([...list.children].map(card=>[Number(card.dataset.id),card]));
    const focused=document.activeElement?.dataset;
    const focusKey=focused?.confirm || focused?.cancel || focused?.reveal;
    const focusKind=focused?.confirm?"confirm":focused?.cancel?"cancel":"reveal";
    const rows=[];
    const statuses={pending:"等待确认",choosing:"正在选择保存位置…",downloading:"正在下载",completed:"下载完成",cancelled:"已取消",failed:"下载失败"};
    for(const record of [...records].reverse()) {
      const reused=existing.get(record.id);
      if(reused && reused.dataset.status===record.status){
        updateProgress(reused,record);
        rows.push(reused);continue;
      }
      const card=document.createElement("article"); card.className="download-card";card.dataset.id=String(record.id);card.dataset.status=record.status;
      animate(card,[{opacity:.4,transform:"translateY(5px)"},{opacity:1,transform:"translateY(0)"}],{duration:200});
      const entry=document.createElement(record.status==="completed"?"button":"div"); entry.className="download-entry";
      if(record.status==="completed"){entry.type="button";entry.dataset.reveal=String(record.id);entry.title="在文件夹中显示";}
      const name=document.createElement("strong");name.textContent=record.name;entry.append(name);
      const line=document.createElement("span");line.className="download-meta";
      line.textContent=(record.status==="pending"&&record.mode==="ask"?"准备选择保存位置…":statuses[record.status])+" · "+sizeText(record.total);entry.append(line);
      if(record.path){const path=document.createElement("span");path.className="download-path";path.textContent=record.path;entry.append(path);}
      card.append(entry);
      if(record.status==="pending" && record.mode==="default") {
        if(record.directory){const destination=document.createElement("p");destination.className="download-path";destination.textContent="保存到："+record.directory;card.append(destination);}
        const actions=document.createElement("div");actions.className="actions";
        const confirm=document.createElement("button");confirm.type="button";confirm.className="primary";confirm.dataset.confirm=String(record.id);confirm.textContent="确认下载";
        const cancel=document.createElement("button");cancel.type="button";cancel.className="quiet";cancel.dataset.cancel=String(record.id);cancel.textContent="取消";
        actions.append(confirm,cancel);card.append(actions);
      }
      if(record.status==="downloading") {
        const bar=document.createElement("div");bar.className="download-progress";bar.setAttribute("role","progressbar");bar.setAttribute("aria-label",record.name+" 下载进度");bar.setAttribute("aria-valuemin","0");bar.setAttribute("aria-valuemax","100");bar.append(document.createElement("span"));
        const info=document.createElement("div");info.className="download-transfer";
        card.append(bar,info);updateProgress(card,record);
      }
      if(record.error){const error=document.createElement("p");error.className="field-error";error.textContent=record.error;card.append(error);}
      rows.push(card);
    }
    // Keep active bars mounted so stream animations and focus survive updates.
    if(rows.length!==list.children.length||rows.some((row,index)=>row!==list.children[index]))list.replaceChildren(...rows);
    if(focusKey)list.querySelector(`[data-${focusKind}="${focusKey}"]`)?.focus({preventScroll:true});
    $("download-empty").hidden=records.length>0;
    const pending=records.filter(record=>["pending","choosing","downloading"].includes(record.status));
    $("download-badge").hidden=activeTab==="downloads"||records.length===0;
    const newRequest=records.find(record=>record.status==="pending"&&!knownRequests.has(record.id));
    records.forEach(record=>knownRequests.add(record.id));
    if(newRequest) {selectTab("downloads");if(newRequest.mode==="default")ui("open");}
    const latest=records.at(-1);
    if(latest && previous.get(latest.id)!==latest.status) {
      downloadNotice={message:statuses[latest.status],failed:latest.status==="failed",finished:latest.status==="completed",pending:pending.some(record=>record.status==="pending"&&record.mode==="default"),choosing:latest.status==="choosing"||(latest.status==="pending"&&latest.mode==="ask"),cancelled:latest.status==="cancelled"};
      clearTimeout(noticeTimer);renderPill();
      if(!pending.length)noticeTimer=setTimeout(()=>{downloadNotice=null;renderPill();},5000);
    }
    if(activeTab==="downloads"&&(previous.size!==records.length||records.some(record=>previous.get(record.id)!==record.status)))ui("height",{height:Math.min(490,210+Math.max(1,records.length)*100)});
  }
  $("download-list").addEventListener("click", async event=>{
    const control=event.target.closest("[data-confirm],[data-cancel],[data-reveal]");if(!control)return;
    const key=control.dataset.confirm?"confirm":control.dataset.cancel?"cancel":"reveal";
    const id=Number(control.dataset[key]);
    $("download-feedback").textContent="";
    const result=await call("client_"+key+"_download",{id},null);
    if(!result?.ok)$("download-feedback").textContent=result?.error?.message||"操作未完成";
  });
  const pill = $("pill");
  let measuredPillWidth=0;
  const pillObserver=new ResizeObserver(()=>{
    const width=Math.ceil(pill.getBoundingClientRect().width);
    if(width===measuredPillWidth)return;
    ui("pill_width",{width}).then(result=>{if(result?.ok)measuredPillWidth=width;});
  });
  pillObserver.observe(pill);

  function selectTab(name, focus = false) {
    activeTab = name;
    for (const item of ["connection", "downloads", "settings"]) {
      $("tab-" + item).setAttribute("aria-selected", String(item === name));
      $("tab-" + item).tabIndex = item === name ? 0 : -1;
      $("page-" + item).hidden = item !== name;
    }
    if (name === "downloads") $("download-badge").hidden = true;
    if (focus) $("tab-" + name).focus();
    document.querySelector("main").scrollTop = 0;
    document.querySelector(".tabs").style.setProperty("--tab-index", String(["connection","downloads","settings"].indexOf(name)));
    animate($("page-"+name),[{opacity:0,transform:"translateY(7px)"},{opacity:1,transform:"translateY(0)"}]);
    ui("height", {height: name === "settings" ? 478 : name === "downloads" ? Math.min(490,210+Math.max(1,downloads.length)*100) : detailsBox.hidden ? 330 : 510});
  }

  function renderPill() {
    const snapshot = lastSnapshot;
    const text = downloadNotice
      ? (downloadNotice.failed ? "下载失败" : downloadNotice.pending ? "等待确认下载" : downloadNotice.choosing ? "选择保存位置" : downloadNotice.cancelled ? "下载已取消" : downloadNotice.finished ? "下载完成" : "正在下载…")
      : snapshot ? (phaseLabels[snapshot.phase] || "正在连接") + (snapshot.kind === "lan" ? " · 局域网" : snapshot.kind === "wan" ? " · 广域" : "") : "正在准备";
    if($("pill-label").textContent!==text){$("pill-label").textContent=text;animate($("pill-label"),[{opacity:0,transform:"translateY(2px)"},{opacity:1,transform:"translateY(0)"}],{duration:150});}
    $("pill-dot").className = "dot " + (downloadNotice ? downloadNotice.failed ? "dot-err" : downloadNotice.finished ? "dot-ok" : "dot-busy" : phaseClass[snapshot?.phase] || "dot-idle");
    pill.title = (downloadNotice?.message || text) + " — 点击打开面板；拖动后 10 秒归位";
  }

  function applyLayout(layout) {
    if (!layout) return;
    const wasExpanded=window.__AXIVER_SHELL__.layout?.expanded;
    window.__AXIVER_SHELL__.layout = layout;
    pill.style.left = layout.pillX + "px";
    pill.style.top = layout.pillY + "px";
    pill.setAttribute("aria-expanded", String(layout.expanded));
    const panel = $("panel");
    panel.hidden = !layout.expanded;
    if(layout.expanded&&!wasExpanded)animate(panel,[{opacity:0,transform:"translateY(-7px) scale(.97)"},{opacity:1,transform:"translateY(0) scale(1)"}],{duration:300});
    panel.style.left = layout.panelX + "px";
    panel.style.top = layout.panelY + "px";
    panel.style.width = layout.panelWidth + "px";
    panel.style.height = layout.panelHeight + "px";
    $("btn-return").hidden = !layout.toolActive;
    materialOffsets(layout);
  }

  async function ui(action, values = {}) {
    if(action==="close"&&closeAnimation)return null;
    if(action==="close"&&!$("panel").hidden&&!closeAnimation&&!motion.matches){
      closeAnimation=true;
      await animate($("panel"),[{opacity:1,transform:"scale(1)"},{opacity:0,transform:"translateY(-5px) scale(.98)"}],{duration:160})?.finished.catch(()=>{});
      closeAnimation=false;
    }
    const result = await call("client_ui_layout", {input: {action, ...(action==="get"?{reducedMotion:motion.matches}:{}), ...values}}, null);
    if (result?.ok) applyLayout(result.data);
    return result;
  }

  for (const name of ["connection", "downloads", "settings"]) {
    $("tab-" + name).addEventListener("click", () => selectTab(name));
    $("tab-" + name).addEventListener("keydown", event => {
      const names = ["connection", "downloads", "settings"];
      let next;
      if (event.key === "ArrowRight") next = (names.indexOf(name) + 1) % 3;
      if (event.key === "ArrowLeft") next = (names.indexOf(name) + 2) % 3;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = 2;
      if (next !== undefined) { event.preventDefault(); selectTab(names[next], true); }
    });
  }

  // Screen coordinates stay stable while the native child view moves.
  pill.addEventListener("pointerdown", event => {
    if (event.button !== 0 || drag) return;
    drag = {id: event.pointerId, x: event.screenX, y: event.screenY, moved: false};
    pill.setPointerCapture(event.pointerId);
  });
  pill.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.screenX - drag.x, dy = event.screenY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      pill.classList.add("dragging");
      moveTail = moveTail.then(() => ui("drag_start"));
    }
    drag.latest = {dx,dy};
    if (drag.flushing) return;
    const session = drag;
    session.flushing = true;
    moveTail = moveTail.then(async () => {
      while (session.latest) {
        const position = session.latest;
        session.latest = null;
        await ui("drag_move", position);
      }
      session.flushing = false;
    });
  });
  function finishDrag(event) {
    if (!drag || drag.id !== event.pointerId) return;
    const moved = drag.moved;
    drag = null;
    pill.classList.remove("dragging");
    if (pill.hasPointerCapture(event.pointerId)) pill.releasePointerCapture(event.pointerId);
    if (moved) {
      suppressClickUntil = performance.now() + 500;
      moveTail = moveTail.then(() => ui("drag_end"));
    }
  }
  pill.addEventListener("pointerup", finishDrag);
  pill.addEventListener("pointercancel", finishDrag);
  pill.addEventListener("lostpointercapture", finishDrag);
  pill.addEventListener("click", event => {
    if (event.detail && performance.now() < suppressClickUntil) { event.preventDefault(); return; }
    if (downloadNotice && $("panel").hidden) selectTab("downloads");
    ui($("panel").hidden?"open":"close");
  });
  pill.addEventListener("keydown", event => {
    if (event.key === "Home") { event.preventDefault(); ui("reset"); }
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("panel").hidden) { event.preventDefault(); ui("close"); }
  });
  $("btn-reset").addEventListener("click", () => ui("reset"));
  $("btn-return").addEventListener("click", () => ui("close_tool"));

  const phaseClass = {
    connected: "dot-ok",
    loading_page: "dot-busy",
    connecting_lan: "dot-busy",
    discovering_lan: "dot-busy",
    scanning_subnet: "dot-busy",
    reconnecting: "dot-busy",
    awaiting_auth: "dot-busy",
    idle: "dot-idle",
    connecting_wan: "dot-wan",
    disconnected: "dot-err",
    error: "dot-err",
  };

  const phaseLabels = {
    idle: "就绪",
    discovering_lan: "正在嗅探局域网",
    scanning_subnet: "正在扫描同网段",
    connecting_lan: "正在连接局域网",
    connecting_wan: "正在连接广域地址",
    loading_page: "正在加载远程页面",
    awaiting_auth: "等待验证",
    connected: "已连接",
    reconnecting: "正在重新连接",
    disconnected: "已断开",
    error: "连接错误",
  };

  function flagText(value) {
    if (value === true) return "是";
    if (value === false) return "否";
    return "未报告";
  }

  function renderStatus(snapshot) {
    if (!snapshot || typeof snapshot.revision !== "number") return;
    if (snapshot.revision <= lastRevision && lastSnapshot) return; // stale
    lastRevision = snapshot.revision;
    lastSnapshot = snapshot;

    statusDot.className = "dot " + (phaseClass[snapshot.phase] || "dot-idle");
    const label = phaseLabels[snapshot.phase] || snapshot.phase;
    statusText.textContent = snapshot.phase === "connected"
      ? label + (snapshot.kind === "lan" ? " · 局域网" : snapshot.kind === "wan" ? " · 广域" : "")
      : snapshot.detail || label;
    statusTarget.textContent = snapshot.targetUrl || "—";
    statusTarget.title = snapshot.targetUrl || "";
    statusTime.textContent = snapshot.lastCheckedAt
      ? `最近检查 ${new Date(snapshot.lastCheckedAt).toLocaleTimeString("zh-CN", {hour12: false})}`
      : "";
    if (snapshot.errorCode) {
      statusError.hidden = false;
      statusError.textContent = `错误代码：${snapshot.errorCode}`;
    } else {
      statusError.hidden = true;
    }
    renderDetails();
    renderPill();
  }

  function renderDetails() {
    if (!lastSnapshot || detailsBox.hidden) return;
    const s = lastSnapshot;
    const rows = [
      ["状态机", s.phase],
      ["线路", s.kind === "lan" ? "局域网" : s.kind === "wan" ? "广域" : "无"],
      ["目标", s.targetUrl || "—"],
      ["TCP 可达", flagText(s.transportReachable)],
      ["页面已加载", flagText(s.pageLoaded)],
      ["会话验证", flagText(s.sessionVerified)],
      ["错误代码", s.errorCode || "无"],
      ["状态版本", String(s.revision)],
      ["最近检查", s.lastCheckedAt || "—"],
    ];
    detailsList.replaceChildren(
      ...rows.flatMap(([key, value]) => {
        const dt = document.createElement("dt");
        dt.textContent = key;
        const dd = document.createElement("dd");
        dd.textContent = value;
        return [dt, dd];
      })
    );
  }

  function renderConfig(next) {
    if (!next) return;
    config = next;
    // Never clobber what the user is editing (legacy drawer behaviour kept).
    if (editingDirty || document.activeElement === broadcastInput || document.activeElement === wideInput) {
      return;
    }
    broadcastInput.value = config.broadcastName || "";
    wideInput.value = config.wideUrl || "";
    clearFieldErrors();
  }

  function clearFieldErrors() {
    broadcastError.hidden = true;
    wideError.hidden = true;
    broadcastInput.setAttribute("aria-invalid", "false");
    wideInput.setAttribute("aria-invalid", "false");
  }

  function setFieldError(which, message) {
    const [input, el] =
      which === "broadcast" ? [broadcastInput, broadcastError] : [wideInput, wideError];
    el.textContent = message;
    el.hidden = false;
    input.setAttribute("aria-invalid", "true");
  }

  function localValidate() {
    let ok = true;
    clearFieldErrors();
    const name = broadcastInput.value.trim();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/i.test(name)) {
      setFieldError("broadcast", "广播名需为 1–32 位字母、数字、下划线或连字符，且以字母或数字开头");
      ok = false;
    }
    const wide = wideInput.value.trim();
    if (wide && !/^https?:\/\/[^\s\/?#]+/i.test(wide)) {
      setFieldError("wide", "请输入完整的 http:// 或 https:// 地址");
      ok = false;
    }
    return ok;
  }

  async function call(command, args, busyKey) {
    if (!invoke) {
      opStatus.textContent = "本地 IPC 不可用";
      return null;
    }
    if (busyKey) {
      if (opBusy) return null;
      opBusy = busyKey;
      setButtonsBusy();
    }
    try {
      return await invoke(command, args);
    } catch (error) {
      return { ok: false, error: { code: "IPC_FAILED", message: String(error), retryable: true } };
    } finally {
      if (busyKey) {
        opBusy = null;
        setButtonsBusy();
      }
    }
  }

  function setButtonsBusy() {
    btnRefresh.disabled = Boolean(opBusy) || saving;
    btnReconnect.disabled = Boolean(opBusy) || saving;
    btnSave.disabled = saving || Boolean(opBusy);
  }

  async function boot() {
    if (!invoke) {
      statusText.textContent = "本地 IPC 不可用，请重启客户端";
      statusDot.className = "dot dot-err";
      return;
    }
    try {
      const [cfg, conn, version, diagnostics, history, downloadOptions] = await Promise.all([
        invoke("client_get_config"),
        invoke("client_get_connection"),
        invoke("client_get_version"),
        invoke("client_get_diagnostics"),
        invoke("client_get_downloads"),
        invoke("client_get_download_settings"),
      ]);
      await ui("get");
      await ui("pill_width",{width:Math.ceil(pill.getBoundingClientRect().width)});
      renderDownloadSettings(downloadOptions?.ok?downloadOptions.data:null);
      renderDownloads(history?.ok ? history.data : []);
      renderConfig(cfg?.ok ? cfg.data : null);
      renderStatus(conn?.ok ? conn.data : null);
      if (version?.ok) {
        const v = version.data;
        versionEl.textContent = `AXIVER Client v${v.version}（${v.buildProfile} / ${v.target}）`;
      }
      if (diagnostics?.ok && diagnostics.data?.dbError) {
        dbWarning.hidden = false;
        dbWarning.textContent = `设置数据库不可用：${diagnostics.data.dbError}（修改不会持久化）`;
      }
    } catch (error) {
      // WebView2 can finish the bundled document before Rust's setup has
      // registered CoreState. Retry that short startup race only.
      if (String(error).includes("state not managed") && bootRetries++ < 10) {
        setTimeout(boot, 150);
        return;
      }
      opStatus.textContent = `初始化失败：${error}`;
    }
    if (listen) {
      try {
        await listen("axiver:connection-status", (event) => renderStatus(event.payload));
        await listen("axiver:config-changed", (event) => renderConfig(event.payload));
      } catch (_error) {
        // eval-push channel below remains available as the fallback transport.
      }
    }
  }

  // ---- events from Rust (both the Tauri event bus and the eval-push
  //      fallback delivered by ConnectionManager.update) --------------------
  window.__AXIVER_SHELL__ = {
    onLayout: applyLayout,
    onBackdrop: renderBackdrop,
    onDownloads: renderDownloads,
    onStatus(snapshot) {
      renderStatus(snapshot);
    },
    onConfig(next) {
      renderConfig(next);
    },
  };

  // ---- actions -------------------------------------------------------------
  btnRefresh.addEventListener("click", async () => {
    opStatus.textContent = "正在刷新页面…";
    const result = await call("client_refresh_remote", undefined, "refresh");
    if (result?.ok) {
      opStatus.textContent = "已发送刷新指令";
    } else {
      opStatus.textContent = `刷新失败：${result?.error?.message || "未知错误"}`;
    }
  });

  btnReconnect.addEventListener("click", async () => {
    opStatus.textContent = "正在重新连接…";
    const result = await call("client_reconnect", undefined, "reconnect");
    if (result?.ok) {
      opStatus.textContent = "已启动完整重新连接";
    } else {
      opStatus.textContent = `重连失败：${result?.error?.message || "未知错误"}`;
    }
  });

  btnDetails.addEventListener("click", () => {
    detailsBox.hidden = !detailsBox.hidden;
    btnDetails.setAttribute("aria-expanded", String(!detailsBox.hidden));
    renderDetails();
    if(!detailsBox.hidden)animate(detailsBox,[{opacity:0,transform:"translateY(-4px)"},{opacity:1,transform:"translateY(0)"}],{duration:240});
    ui("height", {height: detailsBox.hidden ? 330 : 510});
  });

  btnCopyDiag.addEventListener("click", async () => {
    const payload = JSON.stringify(
      {
        client: versionEl.textContent,
        snapshot: lastSnapshot,
        config: config && {
          schemaVersion: config.schemaVersion,
          broadcastName: config.broadcastName,
          // WAN URL may contain an internal hostname: still user-owned data,
          // copied only on explicit click from the trusted panel.
          wideUrl: config.wideUrl,
        },
      },
      null,
      2
    );
    let copied = false;
    try {
      await navigator.clipboard.writeText(payload);
      copied = true;
    } catch (_error) {
      const area = document.createElement("textarea");
      area.value = payload;
      document.body.appendChild(area);
      area.select();
      try {
        copied = document.execCommand("copy");
      } catch (_inner) {
        copied = false;
      }
      area.remove();
    }
    copyResult.textContent = copied ? "已复制" : "复制失败";
    setTimeout(() => {
      copyResult.textContent = "";
    }, 2000);
  });

  async function save() {
    if (saving) return;
    if (!localValidate()) {
      saveStatus.textContent = "请先修正表单中的错误";
      saveStatus.className = "inline-hint failed";
      return;
    }
    saving = true;
    setButtonsBusy();
    saveStatus.textContent = "正在保存…";
    saveStatus.className = "inline-hint";
    const result = await call(
      "client_update_config",
      {
        input: {
          broadcastName: broadcastInput.value.trim(),
          wideUrl: wideInput.value.trim(),
        },
      },
      null
    );
    saving = false;
    setButtonsBusy();
    if (result?.ok && result.data) {
      // Only real persistence success reports "已保存".
      config = result.data;
      editingDirty = false;
      broadcastInput.value = config.broadcastName;
      wideInput.value = config.wideUrl;
      clearFieldErrors();
      saveStatus.textContent = "已保存";
      saveStatus.className = "inline-hint saved";
      dbWarning.hidden = true;
      setTimeout(() => {
        if (saveStatus.textContent === "已保存") {
          saveStatus.textContent = "";
          saveStatus.className = "inline-hint";
        }
      }, 2500);
    } else {
      const error = result?.error || { code: "UNKNOWN", message: "未知错误" };
      saveStatus.textContent = `保存失败：${error.message}`;
      saveStatus.className = "inline-hint failed";
      if (error.code === "INVALID_BROADCAST_NAME") setFieldError("broadcast", error.message);
      if (error.code === "INVALID_WIDE_URL") setFieldError("wide", error.message);
    }
  }

  function cancelEdit() {
    editingDirty = false;
    renderConfig(config);
    saveStatus.textContent = "";
    saveStatus.className = "inline-hint";
    clearFieldErrors();
    broadcastInput.blur();
    wideInput.blur();
  }

  btnSave.addEventListener("click", save);
  btnCancel.addEventListener("click", cancelEdit);
  [broadcastInput, wideInput].forEach((input) => {
    input.addEventListener("input", () => {
      editingDirty = true;
      saveStatus.textContent = "";
      saveStatus.className = "inline-hint";
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelEdit();
      }
    });
  });

  btnPin.addEventListener("click", async () => {
    pinned = !pinned;
    const result = await call("client_set_always_on_top", { enabled: pinned }, null);
    if (!result?.ok) pinned = !pinned;
    btnPin.setAttribute("aria-pressed", String(pinned));
  });

  btnHide.addEventListener("click", async () => {
    await ui("close");
  });

  // Safety net: if neither events nor eval-push delivered anything shortly
  // after boot, poll the authoritative snapshot so the panel never freezes.
  setInterval(() => {
    if (!invoke) return;
    invoke("client_get_connection")
      .then((result) => {
        if (result?.ok) renderStatus(result.data);
      })
      .catch(() => {});
  }, 5000);

  boot();
})();
