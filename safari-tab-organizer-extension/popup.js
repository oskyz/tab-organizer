"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;

function sendMessage(type, payload = {}) {
  if (typeof browser !== "undefined") {
    return api.runtime.sendMessage({ type, ...payload }).then((response) => {
      if (!response || !response.ok) {
        throw new Error(response?.error || "Unknown extension error");
      }
      return response.data;
    });
  }

  return new Promise((resolve, reject) => {
    api.runtime.sendMessage({ type, ...payload }, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      if (!response || !response.ok) {
        reject(new Error(response?.error || "Unknown extension error"));
        return;
      }
      resolve(response.data);
    });
  });
}

function formatTime(ts) {
  if (!ts) {
    return "n/a";
  }
  return new Date(ts).toLocaleString();
}

function truncate(text, max = 80) {
  const input = text || "";
  return input.length > max ? `${input.slice(0, max - 1)}…` : input;
}

function setStatus(message, isError = false) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#b91c1c" : "#0f766e";
}

function renderSummary(summary) {
  const container = document.getElementById("summaryGrid");
  const cards = [
    ["Open Tabs", summary.openTabs],
    ["Duplicates", summary.duplicateTabCount],
    ["Groups", summary.proposedGroups],
    ["Bookmark Suggestions", summary.bookmarkSuggestions]
  ];
  container.innerHTML = cards
    .map(([label, value]) => `<article class="card"><strong>${value}</strong><span>${label}</span></article>`)
    .join("");
}

function renderDuplicates(duplicates) {
  const root = document.getElementById("duplicatesList");
  if (!duplicates.length) {
    root.innerHTML = '<div class="item">No duplicates found.</div>';
    return;
  }
  root.innerHTML = duplicates
    .map((group) => {
      return `
        <div class="item">
          <div><strong>Keep:</strong> ${truncate(group.keepTitle, 60)}</div>
          <div class="url">${group.normalizedUrl}</div>
          <div><strong>Close:</strong> ${group.closeTabs.length} tab(s)</div>
        </div>
      `;
    })
    .join("");
}

function renderGroups(groups) {
  const root = document.getElementById("groupsList");
  if (!groups.length) {
    root.innerHTML = '<div class="item">No groups to create.</div>';
    return;
  }
  root.innerHTML = groups
    .map((group) => `<div class="item"><strong>${group.label}</strong> (${group.tabCount} tabs)</div>`)
    .join("");
}

function renderRecentTabs(tabs) {
  const root = document.getElementById("recentTabsList");
  if (!tabs.length) {
    root.innerHTML = '<div class="item">No tabs available.</div>';
    return;
  }
  root.innerHTML = tabs
    .slice(0, 20)
    .map((tab) => {
      return `
        <div class="item">
          <div>${truncate(tab.title, 70)}</div>
          <div class="url">${truncate(tab.url, 85)}</div>
          <div>Last accessed: ${formatTime(tab.lastAccessed)}</div>
        </div>
      `;
    })
    .join("");
}

function renderBookmarkSuggestions(items) {
  const root = document.getElementById("bookmarkList");
  if (!items.length) {
    root.innerHTML = '<div class="item">No suggestions right now.</div>';
    return;
  }
  root.innerHTML = items
    .map((item, index) => {
      return `
        <label class="item">
          <input type="checkbox" class="bookmark-check" data-index="${index}" checked>
          <strong>${truncate(item.title, 60)}</strong>
          <div class="url">${truncate(item.url, 95)}</div>
          <div>Visits: ${item.visitCount} | Last: ${formatTime(item.lastVisitTime)}</div>
        </label>
      `;
    })
    .join("");
}

function populateFolderSelect(folders, selectedId) {
  const select = document.getElementById("folderSelect");
  const sorted = [...folders].sort((a, b) => a.path.localeCompare(b.path));
  select.innerHTML = sorted
    .map((folder) => {
      const selected = folder.id === selectedId ? "selected" : "";
      return `<option value="${folder.id}" ${selected}>${folder.path}</option>`;
    })
    .join("");
}

let state = {
  overview: null,
  folders: []
};

async function refresh() {
  setStatus("Refreshing...");
  const [overview, folders] = await Promise.all([
    sendMessage("GET_OVERVIEW"),
    sendMessage("GET_BOOKMARK_FOLDERS")
  ]);
  state.overview = overview;
  state.folders = folders;

  renderSummary(overview.summary);
  renderDuplicates(overview.duplicates);
  renderGroups(overview.groups);
  renderRecentTabs(overview.recentTabs);
  renderBookmarkSuggestions(overview.bookmarkSuggestions);

  const lastFolderId = overview.bookmarkPrefs?.lastFolderId || "1";
  populateFolderSelect(folders, lastFolderId);
  setStatus("Ready.");
}

function selectedSuggestions() {
  const checks = Array.from(document.querySelectorAll(".bookmark-check"));
  const selected = checks
    .filter((check) => check.checked)
    .map((check) => Number.parseInt(check.dataset.index, 10))
    .filter((idx) => Number.isInteger(idx))
    .map((idx) => state.overview.bookmarkSuggestions[idx])
    .filter(Boolean);
  return selected;
}

async function onCreateFolder() {
  const parentId = document.getElementById("folderSelect").value || "1";
  const title = window.prompt("Folder name");
  if (!title) {
    return;
  }
  await sendMessage("CREATE_BOOKMARK_FOLDER", { parentId, title });
  await refresh();
  setStatus("Folder created.");
}

async function onBookmarkSelected() {
  const items = selectedSuggestions();
  if (!items.length) {
    setStatus("Select at least one suggestion.", true);
    return;
  }
  const folderId = document.getElementById("folderSelect").value || "1";
  const result = await sendMessage("BOOKMARK_SELECTED", { items, folderId });
  setStatus(`Created ${result.created} bookmark(s).`);
  await refresh();
}

async function onOrganizeNow() {
  const result = await sendMessage("ORGANIZE_NOW");
  setStatus(`Organized tabs. Closed ${result.closed}, grouped ${result.grouped}.`);
  await refresh();
}

async function onCloseDuplicates() {
  const result = await sendMessage("CLOSE_DUPLICATES_ONLY");
  setStatus(`Closed ${result.closed} duplicate tab(s).`);
  await refresh();
}

async function onUndo() {
  const result = await sendMessage("UNDO_LAST_ACTION");
  if (!result.ok) {
    if (result.expired) {
      setStatus("Undo expired (30 seconds).", true);
      return;
    }
    setStatus("Nothing to undo.", true);
    return;
  }
  setStatus(`Undo completed. Restored ${result.restoredTabs}, ungrouped ${result.ungroupedTabs}.`);
  await refresh();
}

function bindEvents() {
  document.getElementById("refreshBtn").addEventListener("click", () => {
    refresh().catch((err) => setStatus(err.message, true));
  });
  document.getElementById("organizeNowBtn").addEventListener("click", () => {
    onOrganizeNow().catch((err) => setStatus(err.message, true));
  });
  document.getElementById("closeDuplicatesBtn").addEventListener("click", () => {
    onCloseDuplicates().catch((err) => setStatus(err.message, true));
  });
  document.getElementById("undoBtn").addEventListener("click", () => {
    onUndo().catch((err) => setStatus(err.message, true));
  });
  document.getElementById("bookmarkSelectedBtn").addEventListener("click", () => {
    onBookmarkSelected().catch((err) => setStatus(err.message, true));
  });
  document.getElementById("newFolderBtn").addEventListener("click", () => {
    onCreateFolder().catch((err) => setStatus(err.message, true));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  refresh().catch((err) => setStatus(err.message, true));
});
