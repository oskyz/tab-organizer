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

function setStatus(message, isError = false) {
  const statusEl = document.getElementById("settingsStatus");
  statusEl.textContent = message || "";
  statusEl.style.color = isError ? "#b91c1c" : "#0f766e";
}

function settingsFromForm() {
  const includePinnedTabs = document.getElementById("includePinnedTabs").checked;
  const bookmarkThresholdCount = Number.parseInt(document.getElementById("bookmarkThresholdCount").value, 10);
  const bookmarkThresholdDays = Number.parseInt(document.getElementById("bookmarkThresholdDays").value, 10);
  const lowUseLookbackMonths = Number.parseInt(document.getElementById("lowUseLookbackMonths").value, 10);
  const lowUseMaxVisitCount = Number.parseInt(document.getElementById("lowUseMaxVisitCount").value, 10);
  const retentionDays = Number.parseInt(document.getElementById("retentionDays").value, 10);
  const excludedPatterns = document.getElementById("excludedPatterns")
    .value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    includePinnedTabs,
    bookmarkThresholdCount,
    bookmarkThresholdDays,
    lowUseLookbackMonths,
    lowUseMaxVisitCount,
    retentionDays,
    excludedPatterns
  };
}

function fillForm(settings) {
  document.getElementById("includePinnedTabs").checked = Boolean(settings.includePinnedTabs);
  document.getElementById("bookmarkThresholdCount").value = settings.bookmarkThresholdCount ?? 5;
  document.getElementById("bookmarkThresholdDays").value = settings.bookmarkThresholdDays ?? 14;
  document.getElementById("lowUseLookbackMonths").value = settings.lowUseLookbackMonths ?? 30;
  document.getElementById("lowUseMaxVisitCount").value = settings.lowUseMaxVisitCount ?? 2;
  document.getElementById("retentionDays").value = settings.retentionDays ?? 30;
  document.getElementById("excludedPatterns").value = (settings.excludedPatterns || []).join("\n");
}

async function loadSettings() {
  const settings = await sendMessage("GET_SETTINGS");
  fillForm(settings);
}

async function saveSettings(event) {
  event.preventDefault();
  const settings = settingsFromForm();
  await sendMessage("SAVE_SETTINGS", { data: settings });
  setStatus("Settings saved.");
}

async function clearData() {
  const confirmed = window.confirm("Delete all extension data and restore defaults?");
  if (!confirmed) {
    return;
  }
  await sendMessage("CLEAR_EXTENSION_DATA");
  const defaults = await sendMessage("GET_SETTINGS");
  fillForm(defaults);
  setStatus("Extension data deleted.");
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("settingsForm").addEventListener("submit", (event) => {
    saveSettings(event).catch((err) => setStatus(err.message, true));
  });

  document.getElementById("clearDataBtn").addEventListener("click", () => {
    clearData().catch((err) => setStatus(err.message, true));
  });

  loadSettings().catch((err) => setStatus(err.message, true));
});
