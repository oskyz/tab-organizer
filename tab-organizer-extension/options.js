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
  const autoApplyRules = document.getElementById("autoApplyRules").checked;
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
    autoApplyRules,
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
  document.getElementById("autoApplyRules").checked = Boolean(settings.autoApplyRules);
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

// ── Rules ────────────────────────────────────────────────────────────────────

const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];

function setRulesStatus(message, isError = false) {
  const el = document.getElementById("rulesStatus");
  el.textContent = message || "";
  el.style.color = isError ? "#b91c1c" : "#0f766e";
}

function generateId() {
  return `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

let rulesState = [];

function getRulesFromDOM() {
  const cards = Array.from(document.querySelectorAll(".rule-card"));
  return cards.map((card) => {
    const id = card.dataset.ruleId;
    const enabled = card.querySelector(".rule-enable-toggle").checked;
    const actionType = card.querySelector(".rule-action-type").value;
    const groupName = card.querySelector(".rule-group-name").value.trim();
    const color = card.querySelector(".rule-group-color").value;

    const conditionRows = Array.from(card.querySelectorAll(".rule-condition-row"));
    const conditions = conditionRows.map((row) => ({
      field: row.querySelector(".cond-field").value,
      operator: row.querySelector(".cond-operator").value,
      value: row.querySelector(".cond-value").value.trim()
    })).filter((c) => c.value !== "");

    return { id, enabled, conditions, action: { type: actionType, groupName, color } };
  });
}

function updateOperatorOptions(fieldSelect, operatorSelect) {
  const field = fieldSelect.value;
  const currentVal = operatorSelect.value;
  operatorSelect.innerHTML = "";

  const ops = field === "inactivity"
    ? [["olderThanDays", "older than (days)"]]
    : [["contains", "contains"], ["equals", "equals"], ["startsWith", "starts with"]];

  for (const [val, label] of ops) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    operatorSelect.appendChild(opt);
  }

  if (ops.some(([v]) => v === currentVal)) {
    operatorSelect.value = currentVal;
  }
}

function buildConditionRow(condition = {}) {
  const row = document.createElement("div");
  row.className = "rule-condition-row";

  const fieldSel = document.createElement("select");
  fieldSel.className = "cond-field";
  for (const [val, label] of [["domain", "Domain"], ["url", "URL"], ["title", "Title"], ["inactivity", "Inactive for"]]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = label;
    fieldSel.appendChild(opt);
  }
  if (condition.field) {
    fieldSel.value = condition.field;
  }

  const opSel = document.createElement("select");
  opSel.className = "cond-operator";
  updateOperatorOptions(fieldSel, opSel);
  if (condition.operator) {
    opSel.value = condition.operator;
  }

  fieldSel.addEventListener("change", () => {
    updateOperatorOptions(fieldSel, opSel);
    updateValuePlaceholder(fieldSel, valueInput);
  });

  const valueInput = document.createElement("input");
  valueInput.type = "text";
  valueInput.className = "cond-value";
  valueInput.value = condition.value !== undefined ? String(condition.value) : "";
  updateValuePlaceholder(fieldSel, valueInput);

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "rule-remove-condition";
  removeBtn.textContent = "✕";
  removeBtn.title = "Remove condition";
  removeBtn.addEventListener("click", () => {
    row.remove();
  });

  row.appendChild(fieldSel);
  row.appendChild(opSel);
  row.appendChild(valueInput);
  row.appendChild(removeBtn);
  return row;
}

function updateValuePlaceholder(fieldSel, valueInput) {
  if (fieldSel.value === "inactivity") {
    valueInput.placeholder = "days (e.g. 7)";
    valueInput.type = "number";
    valueInput.min = "1";
  } else {
    valueInput.placeholder = fieldSel.value === "domain" ? "e.g. dev.azure.com" : "e.g. PR";
    valueInput.type = "text";
    valueInput.removeAttribute("min");
  }
}

function buildRuleCard(rule) {
  const card = document.createElement("div");
  card.className = "rule-card";
  card.dataset.ruleId = rule.id;

  const header = document.createElement("div");
  header.className = "rule-card-header";

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.className = "rule-enable-toggle";
  toggle.checked = Boolean(rule.enabled);
  toggle.title = "Enable/disable rule";

  const label = document.createElement("span");
  label.className = "rule-card-label";
  label.textContent = "Rule";

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "rule-delete-btn";
  deleteBtn.textContent = "Delete Rule";
  deleteBtn.addEventListener("click", () => {
    card.remove();
    saveCurrentRules();
  });

  header.appendChild(toggle);
  header.appendChild(label);
  header.appendChild(deleteBtn);
  card.appendChild(header);

  const conditionsSection = document.createElement("div");
  conditionsSection.className = "rule-conditions-section";

  const condLabel = document.createElement("div");
  condLabel.className = "rule-section-label";
  condLabel.textContent = "Conditions (ALL must match)";
  conditionsSection.appendChild(condLabel);

  const conditionsList = document.createElement("div");
  conditionsList.className = "rule-conditions-list";

  const conditions = Array.isArray(rule.conditions) && rule.conditions.length
    ? rule.conditions
    : [{}];
  for (const cond of conditions) {
    conditionsList.appendChild(buildConditionRow(cond));
  }
  conditionsSection.appendChild(conditionsList);

  const addCondBtn = document.createElement("button");
  addCondBtn.type = "button";
  addCondBtn.className = "rule-add-condition";
  addCondBtn.textContent = "+ Add Condition";
  addCondBtn.addEventListener("click", () => {
    conditionsList.appendChild(buildConditionRow({}));
  });
  conditionsSection.appendChild(addCondBtn);
  card.appendChild(conditionsSection);

  const actionSection = document.createElement("div");
  actionSection.className = "rule-action-section";

  const actionLabel = document.createElement("div");
  actionLabel.className = "rule-section-label";
  actionLabel.textContent = "Action";
  actionSection.appendChild(actionLabel);

  const actionRow = document.createElement("div");
  actionRow.className = "rule-action-row";

  const actionTypeSel = document.createElement("select");
  actionTypeSel.className = "rule-action-type";
  for (const [val, lbl] of [["group", "Move to group"], ["archive", "Archive (collapse)"]]) {
    const opt = document.createElement("option");
    opt.value = val;
    opt.textContent = lbl;
    actionTypeSel.appendChild(opt);
  }
  if (rule.action && rule.action.type) {
    actionTypeSel.value = rule.action.type;
  }

  const groupNameInput = document.createElement("input");
  groupNameInput.type = "text";
  groupNameInput.className = "rule-group-name";
  groupNameInput.placeholder = "Group name";
  groupNameInput.value = (rule.action && rule.action.groupName) ? rule.action.groupName : "";

  const colorSel = document.createElement("select");
  colorSel.className = "rule-group-color";
  for (const c of GROUP_COLORS) {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c.charAt(0).toUpperCase() + c.slice(1);
    colorSel.appendChild(opt);
  }
  if (rule.action && rule.action.color) {
    colorSel.value = rule.action.color;
  }

  function updateActionVisibility() {
    const isArchive = actionTypeSel.value === "archive";
    groupNameInput.style.display = isArchive ? "none" : "";
    colorSel.style.display = isArchive ? "none" : "";
  }
  actionTypeSel.addEventListener("change", updateActionVisibility);
  updateActionVisibility();

  actionRow.appendChild(actionTypeSel);
  actionRow.appendChild(groupNameInput);
  actionRow.appendChild(colorSel);
  actionSection.appendChild(actionRow);
  card.appendChild(actionSection);

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "rule-save-btn";
  saveBtn.textContent = "Save Rule";
  saveBtn.addEventListener("click", () => {
    saveCurrentRules();
  });
  card.appendChild(saveBtn);

  return card;
}

function renderRules(rules) {
  const list = document.getElementById("rulesList");
  list.innerHTML = "";
  if (!rules.length) {
    list.innerHTML = '<p class="rules-empty">No rules yet. Click "Add Rule" to create one.</p>';
    return;
  }
  for (const rule of rules) {
    list.appendChild(buildRuleCard(rule));
  }
}

async function saveCurrentRules() {
  const rules = getRulesFromDOM();
  rulesState = rules;
  await sendMessage("SAVE_RULES", { rules });
  setRulesStatus("Rules saved.");
}

async function addRule() {
  const newRule = {
    id: generateId(),
    enabled: true,
    conditions: [{}],
    action: { type: "group", groupName: "", color: "blue" }
  };
  rulesState = getRulesFromDOM();
  rulesState.push(newRule);
  renderRules(rulesState);
  await sendMessage("SAVE_RULES", { rules: rulesState });
  setRulesStatus("Rule added.");
}

async function applyRulesNow() {
  setRulesStatus("Applying rules...");
  const result = await sendMessage("APPLY_RULES");
  if (result.matched === 0) {
    setRulesStatus("No tabs matched any rules.");
  } else {
    const parts = [];
    if (result.grouped > 0) {
      parts.push(`grouped ${result.grouped} tab(s)`);
    }
    if (result.archived > 0) {
      parts.push(`archived ${result.archived} tab(s)`);
    }
    setRulesStatus(`Done: ${parts.join(", ")} across ${result.groups} group(s).`);
  }
}

async function loadRules() {
  const rules = await sendMessage("GET_RULES");
  rulesState = rules;
  renderRules(rules);
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("addRuleBtn").addEventListener("click", () => {
    addRule().catch((err) => setRulesStatus(err.message, true));
  });
  document.getElementById("applyRulesBtn").addEventListener("click", () => {
    applyRulesNow().catch((err) => setRulesStatus(err.message, true));
  });
  loadRules().catch((err) => setRulesStatus(err.message, true));
});
