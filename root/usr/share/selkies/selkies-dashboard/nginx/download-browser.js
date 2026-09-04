(function () {
  "use strict";

  var MAX_FAVORITES = 20;
  var LEGACY_STORAGE_KEY = "selkies.downloadFavorites.v1";
  var browserRoot = document.querySelector("[data-download-browser]");
  if (!browserRoot) return;

  var rootLabel = browserRoot.querySelector("[data-download-root-label]");
  var rootLink = browserRoot.querySelector("[data-download-root-link]");
  var toggleButton = browserRoot.querySelector("[data-download-favorite-toggle]");
  var statusElement = browserRoot.querySelector("[data-download-status]");
  var favoritesPanel = browserRoot.querySelector("[data-download-favorites]");
  var favoritesList = browserRoot.querySelector("[data-download-favorites-list]");
  var downloadPrefix = normalizePrefix(browserRoot.getAttribute("data-download-prefix"));
  var configuredRoot = decodeBase64Utf8(browserRoot.getAttribute("data-download-root-b64"));
  var currentPath = relativePathFromLocation(downloadPrefix);
  var STORAGE_KEY = "selkies.downloadFavorites.v2:" + downloadPrefix + ":" + configuredRoot;
  var preferenceKey = "download_favorites:" + downloadPrefix + ":" + configuredRoot;
  var favorites = loadFavorites();
  var favoritesEdited = false;

  if (!configuredRoot) configuredRoot = "下载根目录";
  if (rootLabel) rootLabel.textContent = "（" + configuredRoot + "）";
  if (rootLink) rootLink.href = downloadPrefix;

  processDirectoryListing();
  moveToolbarUnderHeading();

  if (currentPath === null) {
    setStatus("当前地址不在下载根目录内，无法收藏此目录。", true);
    if (toggleButton) toggleButton.disabled = true;
  }

  function normalizePrefix(value) {
    var prefix = typeof value === "string" ? value.trim() : "";
    if (!prefix) prefix = "/files/";
    if (prefix.charAt(0) !== "/") prefix = "/" + prefix;
    if (prefix.charAt(prefix.length - 1) !== "/") prefix += "/";
    return prefix.replace(/\/+/g, "/");
  }

  function decodeBase64Utf8(value) {
    if (typeof value !== "string" || !value) return "";
    try {
      var binary = window.atob(value);
      var bytes = new Uint8Array(binary.length);
      for (var index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      if (typeof window.TextDecoder === "function") {
        return new window.TextDecoder("utf-8", { fatal: false }).decode(bytes);
      }
      var escaped = "";
      for (var byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        escaped += "%" + bytes[byteIndex].toString(16).padStart(2, "0");
      }
      return decodeURIComponent(escaped);
    } catch (error) {
      return "";
    }
  }

  function decodePath(value) {
    try {
      return decodeURIComponent(value);
    } catch (error) {
      return null;
    }
  }

  function normalizeRelativePath(value) {
    if (typeof value !== "string") return null;
    var decoded = value.replace(/\\/g, "/");
    if (decoded === null) return null;
    decoded = decoded.replace(/\\/g, "/");
    if (decoded.charAt(0) === "/") return null;
    decoded = decoded.replace(/\/+$/g, "");
    if (!decoded) return "";
    var segments = decoded.split("/");
    for (var index = 0; index < segments.length; index += 1) {
      var segment = segments[index];
      if (!segment || segment === "." || segment === ".." || segment.indexOf("\u0000") !== -1) {
        return null;
      }
    }
    return segments.join("/");
  }

  function relativePathFromLocation(prefix) {
    var pathname = decodePath(window.location.pathname || "");
    if (pathname === null || pathname.indexOf(prefix) !== 0) return null;
    return normalizeRelativePath(pathname.slice(prefix.length));
  }

  function displayPath(relativePath) {
    return relativePath ? configuredRoot.replace(/\/+$/, "") + "/" + relativePath : configuredRoot;
  }

  function processDirectoryListing() {
    var heading = document.querySelector("h1");
    if (heading) {
      var original = (heading.textContent || "").trim();
      var prefixMatch = original.match(/^(.*?\bIndex\s+of\s+)/i);
      var headingPrefix = prefixMatch ? prefixMatch[1] : "";
      heading.textContent = "文件下载";
      document.title = "文件下载";
      if (rootLabel) rootLabel.textContent = displayPath(currentPath === null ? "" : currentPath);
    }
    if (currentPath !== "") return;
    document.querySelectorAll("tr").forEach(function (row) {
      var anchor = row.querySelector("a");
      var label = anchor ? (anchor.textContent || "").trim() : "";
      if (/^Parent directory\/?$/i.test(label)) {
        row.hidden = true;
        row.style.display = "none";
      }
    });
  }

  function moveToolbarUnderHeading() {
    var heading = document.querySelector("h1");
    if (!heading || !heading.parentNode) return;
    heading.parentNode.insertBefore(browserRoot, heading.nextSibling);
  }

  function pathUrl(relativePath) {
    var normalized = normalizeRelativePath(relativePath);
    if (normalized === null) return null;
    var suffix = normalized ? normalized.split("/").map(encodeURIComponent).join("/") + "/" : "";
    return downloadPrefix + suffix;
  }

  function loadFavorites() {
    var parsed;
    try {
      parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || window.localStorage.getItem(LEGACY_STORAGE_KEY) || "[]");
    } catch (error) {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return cleanFavorites(parsed);
  }

  function defaultName(path) {
    return path ? path.split("/").pop() : "根目录";
  }

  function cleanFavorites(parsed) {
    if (!Array.isArray(parsed)) return [];
    var clean = [];
    parsed.forEach(function (entry) {
      var path = normalizeRelativePath(typeof entry === "string" ? entry : entry && entry.path);
      if (path === null || clean.some(function (item) { return item.path === path; }) || clean.length >= MAX_FAVORITES) return;
      var name = typeof entry.name === "string" ? entry.name.trim().slice(0, 80) : "";
      clean.push({ path: path, name: name || defaultName(path) });
    });
    return clean;
  }

  function cacheFavorites() {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites)); }
    catch (_err) { setStatus("浏览器缓存不可用，收藏仍会保存到服务器。", false); }
  }

  function saveFavorites() {
    favoritesEdited = true;
    cacheFavorites();
    if (window.selkiesPreferences) window.selkiesPreferences.save(preferenceKey, favorites.slice());
  }

  function setStatus(message, isError) {
    if (!statusElement) return;
    statusElement.textContent = message || "";
    statusElement.style.color = isError ? "#fda4af" : "#fbbf24";
  }

  function renameFavorite(index) {
    var favorite = favorites[index];
    var dialog = document.createElement("dialog");
    dialog.className = "download-browser-rename";
    dialog.setAttribute("aria-label", "修改收藏名称");
    var form = document.createElement("form");
    var label = document.createElement("label");
    label.textContent = "收藏显示名称";
    var input = document.createElement("input");
    input.value = favorite.name;
    input.maxLength = 80;
    input.required = true;
    label.appendChild(input);
    var buttons = document.createElement("div");
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", function () { dialog.close(); });
    var save = document.createElement("button");
    save.type = "submit";
    save.textContent = "保存名称";
    buttons.append(cancel, save);
    form.append(label, buttons);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var name = input.value.trim();
      if (!name) { input.setCustomValidity("请输入收藏名称"); input.reportValidity(); return; }
      favorites[index] = { path: favorite.path, name: name };
      saveFavorites();
      dialog.close();
      renderFavorites();
    });
    input.addEventListener("input", function () { input.setCustomValidity(""); });
    dialog.appendChild(form);
    dialog.addEventListener("close", function () { dialog.remove(); });
    document.body.appendChild(dialog);
    dialog.showModal();
    input.focus();
    input.select();
  }

  function renderFavorites() {
    if (!favoritesList || !favoritesPanel) return;
    favoritesList.replaceChildren();
    favoritesPanel.hidden = false;
    if (!favorites.length) {
      var empty = document.createElement("li");
      empty.className = "download-browser-empty";
      empty.textContent = "收藏常用文件夹，下次从这里快速打开。";
      favoritesList.appendChild(empty);
    }
    favorites.forEach(function (favorite, index) {
      var item = document.createElement("li");
      item.className = "download-browser-favorite";
      var link = document.createElement("a");
      link.className = "download-browser-favorite-link";
      link.href = pathUrl(favorite.path) || downloadPrefix;
      link.textContent = favorite.name;
      link.title = displayPath(favorite.path);
      if (favorite.path === currentPath) link.setAttribute("aria-current", "page");
      var menu = document.createElement("details");
      menu.className = "download-browser-menu";
      var summary = document.createElement("summary");
      summary.textContent = "⋯";
      summary.setAttribute("aria-label", "管理收藏：" + favorite.name);
      var actions = document.createElement("div");
      actions.className = "download-browser-menu-actions";
      var rename = document.createElement("button");
      rename.type = "button";
      rename.textContent = "修改名称";
      rename.addEventListener("click", function () {
        menu.open = false;
        renameFavorite(index);
      });
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "download-browser-remove";
      remove.textContent = "删除收藏";
      remove.addEventListener("click", function () {
        favorites.splice(index, 1);
        saveFavorites();
        renderFavorites();
        updateToggleButton();
      });
      actions.append(rename, remove);
      menu.append(summary, actions);
      menu.addEventListener("toggle", function () {
        if (menu.open) {
          favoritesList.querySelectorAll("details[open]").forEach(function (other) {
            if (other !== menu) other.open = false;
          });
          actions.style.transform = "";
          var bounds = actions.getBoundingClientRect();
          var shift = bounds.left < 8 ? 8 - bounds.left : Math.min(0, window.innerWidth - 8 - bounds.right);
          if (shift) actions.style.transform = "translateX(" + shift + "px)";
        }
      });
      item.append(link, menu);
      favoritesList.appendChild(item);
    });
  }

  function updateToggleButton() {
    if (!toggleButton || currentPath === null) return;
    var exists = favorites.some(function (entry) { return entry.path === currentPath; });
    toggleButton.textContent = exists ? "已收藏" : "☆ 收藏此文件夹";
    toggleButton.disabled = exists;
  }

  if (toggleButton && currentPath !== null) {
    toggleButton.addEventListener("click", function () {
      if (favorites.some(function (entry) { return entry.path === currentPath; })) return;
      if (favorites.length >= MAX_FAVORITES) { setStatus("最多收藏 20 个目录，请先从收藏菜单中移除一个。", true); return; }
      favorites.unshift({ path: currentPath, name: defaultName(currentPath) });
      saveFavorites();
      updateToggleButton();
      renderFavorites();
      setStatus("已收藏，可在标签的 ⋯ 菜单中修改名称。", false);
    });
  }
  document.addEventListener("click", function (event) {
    favoritesList.querySelectorAll("details[open]").forEach(function (menu) {
      if (!menu.contains(event.target)) menu.open = false;
    });
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") favoritesList.querySelectorAll("details[open]").forEach(function (menu) { menu.open = false; });
  });
  window.addEventListener("selkies-preferences-error", function () {
    setStatus("服务器保存暂未成功，已保留浏览器缓存并自动重试。", true);
  });
  renderFavorites();
  updateToggleButton();
  if (window.selkiesPreferences) {
    window.selkiesPreferences.load().then(function (preferences) {
      if (favoritesEdited) return;
      if (Object.prototype.hasOwnProperty.call(preferences, preferenceKey)) {
        favorites = cleanFavorites(preferences[preferenceKey]);
        cacheFavorites();
        renderFavorites();
        updateToggleButton();
      } else if (favorites.length) {
        saveFavorites();
      }
    }).catch(function () { setStatus("暂时无法读取服务器收藏，正在使用本地缓存。", true); });
  }
})();
