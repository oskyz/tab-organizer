"use strict";

const SETTINGS_KEY = "settings";
const ACTIVITY_KEY = "tabActivity";
const LAST_ACTION_KEY = "lastAction";
const BOOKMARK_PREFS_KEY = "bookmarkPrefs";
const TIME_TRACKING_KEY = "timeTracking";

const HEARTBEAT_ALARM = "timeTrackingHeartbeat";
const HEARTBEAT_PERIOD_MINUTES = 0.5;

const DEFAULT_SETTINGS = {
  includePinnedTabs: false,
  bookmarkThresholdCount: 5,
  bookmarkThresholdDays: 14,
  lowUseLookbackMonths: 30,
  lowUseMaxVisitCount: 2,
  retentionDays: 30,
  excludedPatterns: [
    "google.com/search",
    "accounts.google.com",
    "oauth",
    "callback"
  ]
};

const TRACKING_PARAMS = new Set(["gclid", "fbclid", "ref"]);
const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(value) {
  return new Promise((resolve) => chrome.storage.local.set(value, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function getSettings() {
  const data = await storageGet([SETTINGS_KEY]);
  return { ...DEFAULT_SETTINGS, ...(data[SETTINGS_KEY] || {}) };
}

async function setSettings(next) {
  const current = await getSettings();
  const merged = { ...current, ...next };
  await storageSet({ [SETTINGS_KEY]: merged });
  return merged;
}

function safeUrl(url) {
  try {
    return new URL(url);
  } catch (_err) {
    return null;
  }
}

function normalizeUrl(rawUrl) {
  const parsed = safeUrl(rawUrl);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return null;
  }

  const url = new URL(parsed.toString());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();

  const nextParams = new URLSearchParams();
  const keys = Array.from(url.searchParams.keys()).sort();
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) {
      continue;
    }
    const values = url.searchParams.getAll(key);
    for (const value of values) {
      nextParams.append(key, value);
    }
  }

  url.search = nextParams.toString() ? `?${nextParams.toString()}` : "";
  return url.toString();
}

function isIncognitoTab(tab) {
  return Boolean(tab && tab.incognito);
}

function hashString(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function chooseGroupColor(seed) {
  return GROUP_COLORS[hashString(seed) % GROUP_COLORS.length];
}

function tokenizeTitle(title) {
  const stop = new Set([
    "the", "and", "for", "with", "from", "this", "that", "your", "you", "have",
    "are", "was", "were", "but", "not", "all", "new", "open", "page", "home",
    "dashboard", "login", "sign", "into", "how", "why", "when", "what"
  ]);
  return (title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !stop.has(word));
}

function extractContextKeyword(title) {
  const tokens = tokenizeTitle(title);
  return tokens.length ? tokens[0] : "general";
}

function contextForTab(tab) {
  const parsed = safeUrl(tab.url || "");
  if (!parsed) {
    return { key: "unknown|general", label: "Unknown" };
  }
  const host = parsed.hostname.replace(/^www\./, "");
  const keyword = extractContextKeyword(tab.title || "");
  if (keyword === "general") {
    return { key: `${host}|general`, label: host };
  }
  return { key: `${host}|${keyword}`, label: `${host} - ${keyword}` };
}

async function getAllTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.filter((tab) => !isIncognitoTab(tab));
}

function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function tickActiveTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_err) {
    return;
  }
  if (!tab || isIncognitoTab(tab)) {
    return;
  }
  const ctx = contextForTab(tab);
  if (!ctx || ctx.key === "unknown|general") {
    return;
  }

  const now = Date.now();
  const data = await storageGet([TIME_TRACKING_KEY]);
  const store = data[TIME_TRACKING_KEY] || {};
  const entry = store[ctx.key] || {
    label: ctx.label,
    totalMs: 0,
    dailyMs: 0,
    dayStamp: todayStamp(),
    lastTick: now
  };

  const today = todayStamp();
  if (entry.dayStamp !== today) {
    entry.dailyMs = 0;
    entry.dayStamp = today;
  }

  const elapsed = now - (entry.lastTick || now);
  const MAX_TICK_MS = 5 * 60 * 1000;
  if (elapsed > 0 && elapsed <= MAX_TICK_MS) {
    entry.totalMs += elapsed;
    entry.dailyMs += elapsed;
  }
  entry.label = ctx.label;
  entry.lastTick = now;

  store[ctx.key] = entry;
  await storageSet({ [TIME_TRACKING_KEY]: store });
}

async function getActiveTabId() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab ? activeTab.id : null;
}

async function getTimeReport() {
  const data = await storageGet([TIME_TRACKING_KEY]);
  const store = data[TIME_TRACKING_KEY] || {};
  const today = todayStamp();
  return Object.entries(store)
    .map(([key, entry]) => ({
      key,
      label: entry.label || key,
      totalMs: entry.totalMs || 0,
      dailyMs: entry.dayStamp === today ? (entry.dailyMs || 0) : 0
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

async function cleanupActivity(retentionDays) {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const data = await storageGet([ACTIVITY_KEY]);
  const activity = data[ACTIVITY_KEY] || {};
  let changed = false;

  for (const [key, entry] of Object.entries(activity)) {
    if (!entry || !entry.lastSeen || entry.lastSeen < cutoff) {
      delete activity[key];
      changed = true;
    }
  }

  if (changed) {
    await storageSet({ [ACTIVITY_KEY]: activity });
  }
}

async function upsertActivityForTab(tab, increment = true) {
  if (!tab || !tab.url || isIncognitoTab(tab)) {
    return;
  }
  const normalized = normalizeUrl(tab.url);
  if (!normalized) {
    return;
  }
  const now = Date.now();
  const data = await storageGet([ACTIVITY_KEY]);
  const activity = data[ACTIVITY_KEY] || {};
  const existing = activity[normalized] || {
    url: normalized,
    title: tab.title || normalized,
    firstSeen: now,
    lastSeen: now,
    accessCount: 0
  };

  existing.title = tab.title || existing.title;
  existing.lastSeen = Math.max(existing.lastSeen || now, tab.lastAccessed || now, now);
  if (increment) {
    existing.accessCount += 1;
  }
  activity[normalized] = existing;
  await storageSet({ [ACTIVITY_KEY]: activity });
}

async function buildDuplicatePlan(tabs, includePinnedTabs) {
  const byNormalized = new Map();
  for (const tab of tabs) {
    if (!includePinnedTabs && tab.pinned) {
      continue;
    }
    const normalized = normalizeUrl(tab.url || "");
    if (!normalized) {
      continue;
    }
    if (!byNormalized.has(normalized)) {
      byNormalized.set(normalized, []);
    }
    byNormalized.get(normalized).push(tab);
  }

  const duplicates = [];
  for (const [normalized, sameTabs] of byNormalized.entries()) {
    if (sameTabs.length <= 1) {
      continue;
    }

    const sorted = [...sameTabs].sort((a, b) => {
      if (a.pinned !== b.pinned) {
        return a.pinned ? -1 : 1;
      }
      return (b.lastAccessed || 0) - (a.lastAccessed || 0);
    });

    const keep = sorted[0];
    const close = sorted.slice(1);

    duplicates.push({
      normalizedUrl: normalized,
      keepTabId: keep.id,
      keepTitle: keep.title || keep.url || normalized,
      closeTabIds: close.map((tab) => tab.id),
      closeTabs: close.map((tab) => ({
        id: tab.id,
        title: tab.title || tab.url || normalized,
        url: tab.url || "",
        windowId: tab.windowId,
        index: tab.index,
        pinned: Boolean(tab.pinned)
      }))
    });
  }

  return duplicates;
}

function toClosedTabRecord(tab, fallbackUrl) {
  return {
    id: tab.id,
    title: tab.title || tab.url || fallbackUrl || "Untitled",
    url: tab.url || fallbackUrl || "",
    windowId: tab.windowId,
    index: tab.index,
    pinned: Boolean(tab.pinned)
  };
}

function buildGroupPlan(tabs, includePinnedTabs) {
  const groups = new Map();

  for (const tab of tabs) {
    if (!includePinnedTabs && tab.pinned) {
      continue;
    }
    const normalized = normalizeUrl(tab.url || "");
    if (!normalized) {
      continue;
    }
    const ctx = contextForTab(tab);
    if (!groups.has(ctx.key)) {
      groups.set(ctx.key, {
        key: ctx.key,
        label: ctx.label,
        tabIds: [],
        tabCount: 0
      });
    }
    const group = groups.get(ctx.key);
    group.tabIds.push(tab.id);
    group.tabCount += 1;
  }

  return Array.from(groups.values()).filter((group) => group.tabIds.length > 1);
}

function isExcluded(url, patterns) {
  const value = (url || "").toLowerCase();
  const list = Array.isArray(patterns) ? patterns : [];
  return list.some((pattern) => {
    const clean = (pattern || "").toLowerCase().trim();
    return clean && value.includes(clean);
  });
}

async function isAlreadyBookmarked(url) {
  const matches = await chrome.bookmarks.search({ url });
  return matches.length > 0;
}

async function getBookmarkSuggestions(settings) {
  const now = Date.now();
  const startTime = now - settings.bookmarkThresholdDays * 24 * 60 * 60 * 1000;

  const historyItems = await chrome.history.search({
    text: "",
    startTime,
    maxResults: 5000
  });

  const counts = new Map();
  for (const item of historyItems) {
    const normalized = normalizeUrl(item.url || "");
    if (!normalized) {
      continue;
    }
    if (isExcluded(normalized, settings.excludedPatterns)) {
      continue;
    }
    const entry = counts.get(normalized) || {
      url: normalized,
      title: item.title || normalized,
      visitCount: 0,
      lastVisitTime: item.lastVisitTime || 0
    };
    entry.visitCount += item.visitCount || 1;
    entry.lastVisitTime = Math.max(entry.lastVisitTime, item.lastVisitTime || 0);
    counts.set(normalized, entry);
  }

  const activityData = await storageGet([ACTIVITY_KEY]);
  const activity = activityData[ACTIVITY_KEY] || {};
  for (const [url, info] of Object.entries(activity)) {
    if (isExcluded(url, settings.excludedPatterns)) {
      continue;
    }
    const current = counts.get(url) || {
      url,
      title: info.title || url,
      visitCount: 0,
      lastVisitTime: info.lastSeen || 0
    };
    current.visitCount = Math.max(current.visitCount, info.accessCount || 0);
    current.lastVisitTime = Math.max(current.lastVisitTime, info.lastSeen || 0);
    counts.set(url, current);
  }

  const list = Array.from(counts.values())
    .filter((entry) => entry.visitCount >= settings.bookmarkThresholdCount)
    .sort((a, b) => {
      if (b.visitCount !== a.visitCount) {
        return b.visitCount - a.visitCount;
      }
      return b.lastVisitTime - a.lastVisitTime;
    })
    .slice(0, 25);

  const suggestions = [];
  for (const item of list) {
    // eslint-disable-next-line no-await-in-loop
    const bookmarked = await isAlreadyBookmarked(item.url);
    if (!bookmarked) {
      suggestions.push(item);
    }
  }
  return suggestions;
}

async function getLowUseOpenTabRecommendations(tabs, settings) {
  const lookbackMonths = Number.isFinite(settings.lowUseLookbackMonths)
    ? settings.lowUseLookbackMonths
    : DEFAULT_SETTINGS.lowUseLookbackMonths;
  const maxVisitCount = Number.isFinite(settings.lowUseMaxVisitCount)
    ? settings.lowUseMaxVisitCount
    : DEFAULT_SETTINGS.lowUseMaxVisitCount;

  const now = Date.now();
  const lookbackMs = lookbackMonths * 30 * 24 * 60 * 60 * 1000;
  const startTime = now - lookbackMs;

  const historyItems = await chrome.history.search({
    text: "",
    startTime,
    maxResults: 10000
  });

  const byUrl = new Map();
  for (const item of historyItems) {
    const normalized = normalizeUrl(item.url || "");
    if (!normalized || isExcluded(normalized, settings.excludedPatterns)) {
      continue;
    }
    const entry = byUrl.get(normalized) || {
      visitCount: 0,
      lastVisitTime: 0
    };
    entry.visitCount += item.visitCount || 1;
    entry.lastVisitTime = Math.max(entry.lastVisitTime, item.lastVisitTime || 0);
    byUrl.set(normalized, entry);
  }

  const recommendations = [];
  for (const tab of tabs) {
    if (!settings.includePinnedTabs && tab.pinned) {
      continue;
    }
    const normalized = normalizeUrl(tab.url || "");
    if (!normalized || isExcluded(normalized, settings.excludedPatterns)) {
      continue;
    }
    const info = byUrl.get(normalized) || { visitCount: 0, lastVisitTime: 0 };
    if (info.visitCount > maxVisitCount) {
      continue;
    }
    recommendations.push({
      tabId: tab.id,
      title: tab.title || normalized,
      url: normalized,
      visitCount: info.visitCount,
      lastVisitTime: info.lastVisitTime || tab.lastAccessed || 0
    });
  }

  return recommendations
    .sort((a, b) => {
      if (a.visitCount !== b.visitCount) {
        return a.visitCount - b.visitCount;
      }
      return (a.lastVisitTime || 0) - (b.lastVisitTime || 0);
    })
    .slice(0, 20);
}

async function buildOverview() {
  const settings = await getSettings();
  const tabs = await getAllTabs();
  await cleanupActivity(settings.retentionDays);

  const duplicates = await buildDuplicatePlan(tabs, settings.includePinnedTabs);
  const groups = buildGroupPlan(tabs, settings.includePinnedTabs);
  const recentTabs = [...tabs]
    .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))
    .map((tab) => ({
      id: tab.id,
      title: tab.title || tab.url || "Untitled",
      url: tab.url || "",
      lastAccessed: tab.lastAccessed || 0,
      pinned: Boolean(tab.pinned)
    }));

  const bookmarkSuggestions = await getBookmarkSuggestions(settings);
  const lowUseRecommendations = await getLowUseOpenTabRecommendations(tabs, settings);
  const prefsData = await storageGet([BOOKMARK_PREFS_KEY]);
  const bookmarkPrefs = prefsData[BOOKMARK_PREFS_KEY] || {};

  return {
    settings,
    summary: {
      openTabs: tabs.length,
      duplicateTabCount: duplicates.reduce((acc, group) => acc + group.closeTabIds.length, 0),
      proposedGroups: groups.length,
      bookmarkSuggestions: bookmarkSuggestions.length,
      lowUseRecommendations: lowUseRecommendations.length
    },
    duplicates,
    groups,
    recentTabs,
    bookmarkSuggestions,
    lowUseRecommendations,
    bookmarkPrefs
  };
}

async function closeDuplicatesOnly() {
  const settings = await getSettings();
  const tabs = await getAllTabs();
  const duplicates = await buildDuplicatePlan(tabs, settings.includePinnedTabs);
  const closeTabs = duplicates.flatMap((group) => group.closeTabs);

  if (closeTabs.length) {
    const ids = closeTabs.map((tab) => tab.id);
    await chrome.tabs.remove(ids);
  }

  await storageSet({
    [LAST_ACTION_KEY]: {
      type: "close-duplicates",
      timestamp: Date.now(),
      closedTabs: closeTabs,
      groupedTabIds: []
    }
  });

  return {
    closed: closeTabs.length
  };
}

async function organizeNow() {
  const settings = await getSettings();
  const tabs = await getAllTabs();
  const duplicates = await buildDuplicatePlan(tabs, settings.includePinnedTabs);

  const closeTabs = duplicates.flatMap((group) => group.closeTabs);
  const closeIds = new Set(closeTabs.map((tab) => tab.id));

  if (closeTabs.length) {
    await chrome.tabs.remove(Array.from(closeIds));
  }

  const remainingTabs = (await getAllTabs()).filter((tab) => !closeIds.has(tab.id));
  const groups = buildGroupPlan(remainingTabs, settings.includePinnedTabs);
  const groupedTabIds = [];

  for (const group of groups) {
    const tabIds = group.tabIds.filter(Boolean);
    if (tabIds.length <= 1) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const groupId = await chrome.tabs.group({ tabIds });
    // eslint-disable-next-line no-await-in-loop
    await chrome.tabGroups.update(groupId, {
      title: group.label.slice(0, 80),
      color: chooseGroupColor(group.key),
      collapsed: false
    });
    groupedTabIds.push(...tabIds);
  }

  await storageSet({
    [LAST_ACTION_KEY]: {
      type: "organize",
      timestamp: Date.now(),
      closedTabs: closeTabs,
      groupedTabIds
    }
  });

  return {
    closed: closeTabs.length,
    grouped: groups.length
  };
}

async function undoLastAction() {
  const data = await storageGet([LAST_ACTION_KEY]);
  const lastAction = data[LAST_ACTION_KEY];
  if (!lastAction || !lastAction.timestamp) {
    return { restoredTabs: 0, ungroupedTabs: 0, ok: false };
  }

  const ageMs = Date.now() - lastAction.timestamp;
  if (ageMs > 30 * 1000) {
    await storageRemove([LAST_ACTION_KEY]);
    return { restoredTabs: 0, ungroupedTabs: 0, ok: false, expired: true };
  }

  let restoredTabs = 0;
  for (const tab of lastAction.closedTabs || []) {
    const createInfo = {
      url: tab.url,
      active: false
    };
    if (Number.isInteger(tab.windowId)) {
      createInfo.windowId = tab.windowId;
    }
    if (Number.isInteger(tab.index)) {
      createInfo.index = tab.index;
    }
    if (tab.pinned) {
      createInfo.pinned = true;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await chrome.tabs.create(createInfo);
      restoredTabs += 1;
    } catch (_err) {
      // Best-effort restore; continue with next tab.
    }
  }

  let ungroupedTabs = 0;
  const tabIds = (lastAction.groupedTabIds || []).filter(Boolean);
  if (tabIds.length) {
    try {
      await chrome.tabs.ungroup(tabIds);
      ungroupedTabs = tabIds.length;
    } catch (_err) {
      // Tab set may have changed after action.
    }
  }

  await storageRemove([LAST_ACTION_KEY]);
  return { restoredTabs, ungroupedTabs, ok: true };
}

async function getBookmarkFolders() {
  const tree = await chrome.bookmarks.getTree();
  const folders = [];

  function walk(node, path) {
    const title = node.title || "Bookmarks";
    const currentPath = path ? `${path} / ${title}` : title;

    if (!node.url) {
      folders.push({
        id: node.id,
        title,
        path: currentPath
      });
    }

    if (node.children && node.children.length) {
      for (const child of node.children) {
        walk(child, currentPath);
      }
    }
  }

  for (const root of tree) {
    walk(root, "");
  }
  return folders;
}

async function createBookmarkFolder(parentId, title) {
  const cleanTitle = (title || "").trim();
  if (!cleanTitle) {
    throw new Error("Folder title is required");
  }
  const folder = await chrome.bookmarks.create({
    parentId: parentId || "1",
    title: cleanTitle
  });
  await storageSet({
    [BOOKMARK_PREFS_KEY]: {
      lastFolderId: folder.parentId || parentId || "1"
    }
  });
  return folder;
}

async function bookmarkSelected(items, folderId) {
  if (!Array.isArray(items) || !items.length) {
    return { created: 0 };
  }

  const targetFolderId = folderId || "1";
  let created = 0;
  for (const item of items) {
    if (!item || !item.url) {
      continue;
    }
    const normalized = normalizeUrl(item.url);
    if (!normalized) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const exists = await isAlreadyBookmarked(normalized);
    if (exists) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await chrome.bookmarks.create({
      parentId: targetFolderId,
      title: item.title || normalized,
      url: normalized
    });
    created += 1;
  }

  await storageSet({
    [BOOKMARK_PREFS_KEY]: {
      lastFolderId: targetFolderId
    }
  });

  return { created };
}

async function closeTabsByIds(tabIds) {
  const tabs = await getAllTabs();
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const ids = Array.isArray(tabIds) ? tabIds : [];
  const targetTabs = ids
    .map((id) => byId.get(id))
    .filter(Boolean);

  const closedTabs = [];
  for (const tab of targetTabs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await chrome.tabs.remove(tab.id);
      closedTabs.push(toClosedTabRecord(tab));
    } catch (_err) {
      // Skip tabs that can no longer be closed.
    }
  }

  await storageSet({
    [LAST_ACTION_KEY]: {
      type: "close-selected",
      timestamp: Date.now(),
      closedTabs,
      groupedTabIds: []
    }
  });

  return { closed: closedTabs.length };
}

async function clearExtensionData() {
  await storageRemove([ACTIVITY_KEY, LAST_ACTION_KEY, BOOKMARK_PREFS_KEY, TIME_TRACKING_KEY]);
  await storageSet({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(async () => {
  await setSettings(DEFAULT_SETTINGS);
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEARTBEAT_ALARM) {
    return;
  }
  const tabId = await getActiveTabId();
  if (tabId !== null) {
    await tickActiveTab(tabId);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  await cleanupActivity(settings.retentionDays);
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_PERIOD_MINUTES });
});

chrome.tabs.onActivated.addListener(async ({ tabId, previousTabId }) => {
  try {
    if (previousTabId) {
      await tickActiveTab(previousTabId);
    }
    const tab = await chrome.tabs.get(tabId);
    await upsertActivityForTab(tab, true);
    await tickActiveTab(tabId);
  } catch (_err) {
    // Ignore transient tab activation errors.
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete") {
    await upsertActivityForTab(tab, true);
    await tickActiveTab(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (!message || !message.type) {
      return { ok: false, error: "Missing message type" };
    }

    switch (message.type) {
      case "GET_OVERVIEW":
        return { ok: true, data: await buildOverview() };
      case "ORGANIZE_NOW":
        return { ok: true, data: await organizeNow() };
      case "CLOSE_DUPLICATES_ONLY":
        return { ok: true, data: await closeDuplicatesOnly() };
      case "UNDO_LAST_ACTION":
        return { ok: true, data: await undoLastAction() };
      case "GET_SETTINGS":
        return { ok: true, data: await getSettings() };
      case "SAVE_SETTINGS":
        return { ok: true, data: await setSettings(message.data || {}) };
      case "GET_BOOKMARK_FOLDERS":
        return { ok: true, data: await getBookmarkFolders() };
      case "CREATE_BOOKMARK_FOLDER":
        return {
          ok: true,
          data: await createBookmarkFolder(message.parentId, message.title)
        };
      case "BOOKMARK_SELECTED":
        return {
          ok: true,
          data: await bookmarkSelected(message.items || [], message.folderId)
        };
      case "CLOSE_TABS_BY_IDS":
        return {
          ok: true,
          data: await closeTabsByIds(message.tabIds || [])
        };
      case "CLEAR_EXTENSION_DATA":
        return { ok: true, data: await clearExtensionData() };
      case "GET_TIME_REPORT":
        return { ok: true, data: await getTimeReport() };
      default:
        return { ok: false, error: `Unknown message type: ${message.type}` };
    }
  })()
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));

  return true;
});
