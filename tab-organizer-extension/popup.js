"use strict";

function sendMessage(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
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

function formatDuration(ms) {
  if (!ms || ms < 1000) {
    return "< 1m";
  }
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  return `${minutes}m`;
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

function renderSummary(summary, contextsTracked) {
  const container = document.getElementById("summaryGrid");
  const cards = [
    ["Open Tabs", summary.openTabs],
    ["Duplicates", summary.duplicateTabCount],
    ["Cross-Window Dupes", summary.crossWindowDuplicateCount ?? 0],
    ["Groups", summary.proposedGroups],
    ["Bookmark Suggestions", summary.bookmarkSuggestions],
    ["Low-Use Tabs", summary.lowUseRecommendations],
    ["Contexts Tracked", contextsTracked]
  ];
  container.innerHTML = cards
    .map(([label, value]) => `<article class="card"><strong>${value}</strong><span>${label}</span></article>`)
    .join("");
}

function renderTimeTracking(report) {
  const root = document.getElementById("timeTrackingList");
  if (!report || !report.length) {
    root.innerHTML = '<div class="item">No time tracked yet.</div>';
    return;
  }
  const maxMs = report[0].totalMs || 1;
  root.innerHTML = report
    .slice(0, 30)
    .map((entry) => {
      const pct = Math.round((entry.totalMs / maxMs) * 100);
      const todayText = entry.dailyMs > 0 ? `${formatDuration(entry.dailyMs)} today · ` : "";
      return `
        <div class="item">
          <div><strong>${truncate(entry.label, 60)}</strong></div>
          <div class="time-meta">${todayText}${formatDuration(entry.totalMs)} total</div>
          <div class="time-bar-wrap"><div class="time-bar" style="width:${pct}%"></div></div>
        </div>
      `;
    })
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
      const badge = group.crossWindow ? ' <span class="badge">cross-window</span>' : '';
      const closeDetails = group.closeTabs
        .map((tab) => {
          const winNote = group.crossWindow ? ` · window ${tab.windowId}` : '';
          return `
            <div class="affected-tab">
              <div>${truncate(tab.title, 55)}${winNote}</div>
              <div class="url">${truncate(tab.url, 80)}</div>
            </div>`;
        })
        .join("");
      return `
        <div class="item">
          <div><strong>Keep:</strong> ${truncate(group.keepTitle, 60)}${badge}</div>
          <div class="url">Window ${group.keepWindowId} &mdash; ${group.normalizedUrl}</div>
          <div class="affected-tabs-header"><strong>Close (${group.closeTabs.length}):</strong>${closeDetails}</div>
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

function renderReopenBanner(suggestion) {
  const banner = document.getElementById("reopenBanner");
  if (!suggestion || !Array.isArray(suggestion.tabs) || !suggestion.tabs.length) {
    banner.hidden = true;
    return;
  }
  document.getElementById("reopenBannerLabel").textContent =
    `${suggestion.tabs.length} ${suggestion.label}`;
  const listEl = document.getElementById("reopenBannerList");
  listEl.innerHTML = suggestion.tabs
    .slice(0, 10)
    .map((tab) => `<div class="reopen-banner-item">${truncate(tab.title || tab.url, 65)}</div>`)
    .join("");
  if (suggestion.tabs.length > 10) {
    listEl.innerHTML += `<div class="reopen-banner-item reopen-banner-more">…and ${suggestion.tabs.length - 10} more</div>`;
  }
  banner.hidden = false;
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

function renderLowUseRecommendations(items, lookbackMonths) {
  const root = document.getElementById("lowUseList");
  const heading = document.getElementById("lowUseHeading");
  heading.textContent = `Low-Use Tabs (last ${lookbackMonths} months)`;
  if (!items.length) {
    root.innerHTML = '<div class="item">No low-use tabs found in the window.</div>';
    return;
  }
  root.innerHTML = items
    .map((item, index) => {
      return `
        <label class="item">
          <input type="checkbox" class="low-use-check" data-index="${index}" checked>
          <strong>${truncate(item.title, 60)}</strong>
          <div class="url">${truncate(item.url, 95)}</div>
          <div>Visits (${lookbackMonths} months): ${item.visitCount} | Last: ${formatTime(item.lastVisitTime)}</div>
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
  const [overview, folders, timeReport, reopenSuggestion] = await Promise.all([
    sendMessage("GET_OVERVIEW"),
    sendMessage("GET_BOOKMARK_FOLDERS"),
    sendMessage("GET_TIME_REPORT"),
    sendMessage("GET_REOPEN_SUGGESTIONS")
  ]);
  state.overview = overview;
  state.folders = folders;

  renderSummary(overview.summary, timeReport.length);
  renderDuplicates(overview.duplicates);
  renderGroups(overview.groups);
  renderRecentTabs(overview.recentTabs);
  renderBookmarkSuggestions(overview.bookmarkSuggestions);
  renderLowUseRecommendations(
    overview.lowUseRecommendations,
    overview.settings?.lowUseLookbackMonths ?? 30
  );
  renderTimeTracking(timeReport);
  renderReopenBanner(reopenSuggestion);

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

function selectedLowUseRecommendations() {
  const checks = Array.from(document.querySelectorAll(".low-use-check"));
  return checks
    .filter((check) => check.checked)
    .map((check) => Number.parseInt(check.dataset.index, 10))
    .filter((idx) => Number.isInteger(idx))
    .map((idx) => state.overview.lowUseRecommendations[idx])
    .filter(Boolean);
}

function deselectAllLowUse() {
  const checks = Array.from(document.querySelectorAll(".low-use-check"));
  for (const check of checks) {
    check.checked = false;
  }
  setStatus("Deselected all low-use tabs.");
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

async function onBookmarkLowUse() {
  const items = selectedLowUseRecommendations().map((item) => ({
    title: item.title,
    url: item.url
  }));
  if (!items.length) {
    setStatus("Select at least one low-use tab.", true);
    return;
  }
  const folderId = document.getElementById("folderSelect").value || "1";
  const result = await sendMessage("BOOKMARK_SELECTED", { items, folderId });
  setStatus(`Created ${result.created} bookmark(s) from low-use tabs.`);
  await refresh();
}

async function onCloseLowUse() {
  const tabIds = selectedLowUseRecommendations().map((item) => item.tabId).filter(Boolean);
  if (!tabIds.length) {
    setStatus("Select at least one low-use tab.", true);
    return;
  }
  const result = await sendMessage("CLOSE_TABS_BY_IDS", { tabIds });
  setStatus(`Closed ${result.closed} low-use tab(s).`);
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

async function onCloseCrossWindowDuplicates() {
  const result = await sendMessage("CLOSE_CROSS_WINDOW_DUPLICATES");
  setStatus(`Closed ${result.closed} cross-window duplicate tab(s).`);
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
  document.getElementById("closeCrossWindowDupsBtn").addEventListener("click", () => {
    onCloseCrossWindowDuplicates().catch((err) => setStatus(err.message, true));
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
  document.getElementById("bookmarkLowUseBtn").addEventListener("click", () => {
    onBookmarkLowUse().catch((err) => setStatus(err.message, true));
  });
  document.getElementById("closeLowUseBtn").addEventListener("click", () => {
    onCloseLowUse().catch((err) => setStatus(err.message, true));
  });
  document.getElementById("deselectLowUseBtn").addEventListener("click", () => {
    deselectAllLowUse();
  });
  document.getElementById("reopenRestoreBtn").addEventListener("click", () => {
    sendMessage("RESTORE_REOPEN_SUGGESTIONS")
      .then((result) => {
        setStatus(`Restored ${result.restored} tab(s).`);
        return refresh();
      })
      .catch((err) => setStatus(err.message, true));
  });
  document.getElementById("reopenDismissBtn").addEventListener("click", () => {
    sendMessage("DISMISS_REOPEN_SUGGESTIONS")
      .then(() => {
        document.getElementById("reopenBanner").hidden = true;
        setStatus("Suggestion dismissed.");
      })
      .catch((err) => setStatus(err.message, true));
  });
}

document.addEventListener("DOMContentLoaded", () => {
  bindEvents();
  refresh().catch((err) => setStatus(err.message, true));
});
