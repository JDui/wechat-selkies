(function () {
  "use strict";

  var MAX_FAVORITES = 20;
  var STORAGE_KEY = "selkies.downloadFavorites.v1";
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
  var favorites = loadFavorites();

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
    var decoded = decodePath(value.replace(/\\/g, "/"));
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
      heading.textContent = headingPrefix + displayPath(currentPath === null ? "" : currentPath);
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
      parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    } catch (error) {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    var clean = [];
    parsed.forEach(function (entry) {
      var normalized = normalizeRelativePath(entry);
      if (normalized !== null && clean.indexOf(normalized) === -1 && clean.length < MAX_FAVORITES) {
        clean.push(normalized);
      }
    });
    return clean;
  }

  function saveFavorites() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites.slice(0, MAX_FAVORITES)));
    } catch (error) {
      setStatus("浏览器无法保存收藏，请检查 localStorage 设置。", true);
    }
  }

  function setStatus(message, isError) {
    if (!statusElement) return;
    statusElement.textContent = message || "";
    statusElement.style.color = isError ? "#fda4af" : "#fbbf24";
  }

  function renderFavorites() {
    if (!favoritesList || !favoritesPanel) return;
    while (favoritesList.firstChild) favoritesList.removeChild(favoritesList.firstChild);
    favoritesPanel.hidden = favorites.length === 0;
    favorites.forEach(function (favorite, index) {
      var item = document.createElement("li");
      item.className = "download-browser-favorite";
      var link = document.createElement("a");
      link.className = "download-browser-favorite-link";
      link.href = pathUrl(favorite) || downloadPrefix;
      link.textContent = displayPath(favorite);
      var remove = document.createElement("button");
      remove.className = "download-browser-remove";
      remove.type = "button";
      remove.textContent = "删除";
      remove.addEventListener("click", function () {
        favorites.splice(index, 1);
        saveFavorites();
        renderFavorites();
        updateToggleButton();
      });
      item.appendChild(link);
      item.appendChild(remove);
      favoritesList.appendChild(item);
    });
  }

  function updateToggleButton() {
    if (!toggleButton || currentPath === null) return;
    toggleButton.textContent = favorites.indexOf(currentPath) === -1 ? "收藏当前目录" : "取消收藏当前目录";
  }

  if (toggleButton && currentPath !== null) {
    toggleButton.addEventListener("click", function () {
      var existingIndex = favorites.indexOf(currentPath);
      if (existingIndex !== -1) {
        favorites.splice(existingIndex, 1);
        setStatus("已取消收藏当前目录。", false);
      } else {
        favorites = [currentPath].concat(favorites.filter(function (entry) { return entry !== currentPath; }));
        favorites = favorites.slice(0, MAX_FAVORITES);
        setStatus("已收藏当前目录。", false);
      }
      saveFavorites();
      updateToggleButton();
      renderFavorites();
    });
  }

  renderFavorites();
  updateToggleButton();
})();
