const api = window.droidProxy;

const elements = {
  proxyStatus: document.querySelector("#proxy-status"),
  serverDot: document.querySelector("#server-dot"),
  toggleServer: document.querySelector("#toggle-server-btn"),
  endpoint: document.querySelector("#endpoint-code"),
  copyEndpoint: document.querySelector("#copy-endpoint-btn"),
  debug: document.querySelector("#debug-input"),
  usage: document.querySelector("#usage-list"),
  logs: document.querySelector("#log-output"),
  factoryStatus: document.querySelector("#factory-status"),
  toast: document.querySelector("#toast")
};

let currentAccounts = [];
let toastTimer;

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => {
    elements.toast.hidden = true;
  }, 5200);
}

function setSettingsForm(settings) {
  elements.debug.checked = settings.debug;
  renderEndpoint(settings);
}

function renderEndpoint(settings) {
  elements.endpoint.textContent = `http://${settings.host}:${settings.port}/v1`;
}

async function saveDebugLogging() {
  try {
    await api.saveSettings({ debug: elements.debug.checked });
    showToast("Logging setting saved.");
  } catch (error) {
    showToast(error.message || String(error));
  }
}

function renderProxyState(state) {
  const running = state.running;
  elements.proxyStatus.textContent = running ? `Running · PID ${state.pid}` : "Stopped";
  elements.serverDot.classList.toggle("running", running);
  elements.endpoint.textContent = state.baseUrl;
}

function renderLogs(logs) {
  elements.logs.textContent = logs.join("\n");
  elements.logs.scrollTop = elements.logs.scrollHeight;
}

// Each connected account is listed under its provider. An expired access token
// is still authorized: the backend refreshes it on the next request.
function renderAccounts(accounts) {
  currentAccounts = accounts;
  document.querySelectorAll(".provider[data-provider]").forEach((row) => {
    const mine = accounts.filter((account) => account.provider === row.dataset.provider);
    const container = row.querySelector(".provider-accounts");
    if (!container) return;
    row.classList.toggle("connected", mine.some((account) => !account.disabled));
    const button = row.querySelector(".login-btn");
    if (button) button.textContent = mine.length ? "Add account" : "Connect";
    container.innerHTML = mine.length
      ? mine.map((account) => `
        <div class="authorized ${account.disabled ? "off" : ""}">
          <span class="auth-badge">${account.disabled ? "Disabled" : "Authorized"}</span>
          <span class="auth-email">${escapeHtml(account.email)}</span>
        </div>`).join("")
      : `<div class="authorized none">Not connected</div>`;
  });
}

let routing = null;

function modelSelect(id, selected, includeNone) {
  const options = (routing?.models || []).map((model) =>
    `<option value="${escapeHtml(model.id)}" ${model.id === selected ? "selected" : ""}>${escapeHtml(model.label)}</option>`).join("");
  return `<select id="${escapeHtml(id)}">${includeNone ? `<option value="">(none)</option>` : ""}${options}</select>`;
}

const labelFor = (modelId) => routing?.models.find((model) => model.id === modelId)?.label || modelId;

function renderRouting(state) {
  routing = state;
  document.querySelector("#auto-enabled").checked = state.autoEnabled;
  document.querySelector("#fallback-enabled").checked = state.fallbackEnabled;

  document.querySelector("#category-list").innerHTML = state.categories.map((category) => {
    const roles = state.roles.map((roleItem) => {
      const cell = state.roleModels?.[category.key]?.[roleItem.key] || {};
      return `
        <div class="role-row" data-category="${escapeHtml(category.key)}" data-role="${escapeHtml(roleItem.key)}">
          <span class="role-label">${escapeHtml(roleItem.label)}</span>
          <div class="role-selects">
            ${modelSelect(`role-${category.key}-${roleItem.key}-model`, cell.model, false)}
            ${modelSelect(`role-${category.key}-${roleItem.key}-backup`, cell.backup || "", true)}
            ${modelSelect(`role-${category.key}-${roleItem.key}-backup2`, cell.backup2 || "", true)}
          </div>
        </div>`;
    }).join("");
    return `
      <div class="category-block" title="${escapeHtml(category.description)}">
        <div class="routing-row">
          <span class="routing-label category-name">${escapeHtml(category.key[0].toUpperCase() + category.key.slice(1))}</span>
          ${modelSelect(`cat-${category.key}`, state.categoryModels[category.key], false)}
        </div>
        <div class="role-head"><span></span><span>Model</span><span>Backup</span><span>Backup 2</span></div>
        ${roles}
      </div>`;
  }).join("");

  document.querySelector("#chain-list").innerHTML = state.models.map((model) => {
    const chain = state.fallbackChains[model.id] || [];
    const selects = [0, 1, 2].map((slot) => modelSelect(`chain-${model.id}-${slot}`, chain[slot] || "", true)).join("");
    return `
      <div class="routing-row chain" data-model="${escapeHtml(model.id)}">
        <span class="routing-label">${escapeHtml(model.label)}</span>
        <div class="chain-selects">${selects}</div>
      </div>`;
  }).join("");

  document.querySelector("#balanced-enabled").checked = state.balanced;
  document.querySelector("#overflow-threshold").value = state.overflowThreshold;
  const overflowSelects = (prefix, list, count) => Array.from({ length: count }, (_, slot) => modelSelect(`${prefix}-${slot}`, list[slot] || "", true)).join("");
  document.querySelector("#overflow-selects").innerHTML = overflowSelects("overflow", state.overflowModels, 3);
  document.querySelector("#mission-overflow-selects").innerHTML = overflowSelects("mission-overflow", state.missionOverflowModels, 3);

  const premium = state.premium || {};
  document.querySelector("#premium-enabled").checked = premium.enabled !== false;
  document.querySelector("#premium-model-select").innerHTML = modelSelect("premium-model", premium.model, false);
  document.querySelector("#premium-threshold").value = premium.threshold ?? 60;
  document.querySelector("#premium-categories").innerHTML = state.categories.map((category) => `
    <label class="check-row"><input type="checkbox" value="${escapeHtml(category.key)}" ${(premium.categories || []).includes(category.key) ? "checked" : ""} /> ${escapeHtml(category.key[0].toUpperCase() + category.key.slice(1))}</label>`).join("");

  renderCooling(state);
}

const QUOTA_LABELS = {
  codex: "Codex",
  claude: "Claude",
  "antigravity-gemini": "Google · Gemini",
  "antigravity-claude": "Google · Claude"
};

function renderQuotas(state) {
  const entries = Object.entries(state.quotas?.buckets || {});
  document.querySelector("#quota-snapshot").innerHTML = entries.length
    ? entries.map(([bucket, left]) => `<span class="quota-pill ${left < state.overflowThreshold ? "low" : ""}">${escapeHtml(QUOTA_LABELS[bucket] || bucket)} ${Math.round(left)}% left</span>`).join("")
      + (state.quotas.updatedAt ? `<span class="usage-note">updated ${new Date(state.quotas.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>` : "")
    : `<span class="usage-note">Reading subscription quotas…</span>`;
}

function renderCooling(state) {
  renderQuotas(state);
  const cooling = document.querySelector("#cooling-list");
  cooling.innerHTML = state.cooling.length
    ? state.cooling.map((item) => `<div class="cooling">${escapeHtml(labelFor(item.model))}: out of quota, skipped until ${new Date(item.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>`).join("")
    : "";
}

function collectRouting() {
  const categoryModels = Object.fromEntries(routing.categories.map((category) =>
    [category.key, document.querySelector(`#cat-${CSS.escape(category.key)}`).value]));
  const fallbackChains = {};
  document.querySelectorAll(".routing-row.chain").forEach((row) => {
    const chain = [...row.querySelectorAll("select")].map((select) => select.value).filter(Boolean);
    fallbackChains[row.dataset.model] = [...new Set(chain)].filter((item) => item !== row.dataset.model);
  });
  const roleModels = {};
  document.querySelectorAll(".role-row").forEach((row) => {
    const [model, backup, backup2] = [...row.querySelectorAll("select")].map((select) => select.value);
    roleModels[row.dataset.category] = roleModels[row.dataset.category] || {};
    roleModels[row.dataset.category][row.dataset.role] = { model, backup, backup2 };
  });
  const pickList = (container) => [...new Set([...document.querySelectorAll(`${container} select`)].map((select) => select.value).filter(Boolean))];
  return {
    autoEnabled: document.querySelector("#auto-enabled").checked,
    fallbackEnabled: document.querySelector("#fallback-enabled").checked,
    categoryModels,
    roleModels,
    fallbackChains,
    balanced: document.querySelector("#balanced-enabled").checked,
    overflowThreshold: Number(document.querySelector("#overflow-threshold").value),
    overflowModels: pickList("#overflow-selects"),
    missionOverflowModels: pickList("#mission-overflow-selects"),
    premium: {
      enabled: document.querySelector("#premium-enabled").checked,
      model: document.querySelector("#premium-model").value,
      threshold: Number(document.querySelector("#premium-threshold").value),
      categories: [...document.querySelectorAll("#premium-categories input:checked")].map((input) => input.value)
    }
  };
}

let modes = null;

function renderModes(state) {
  modes = state;
  const efforts = (selected) => [`<option value="">Model default</option>`, ...state.efforts.map((effort) =>
    `<option value="${effort}" ${effort === selected ? "selected" : ""}>${effort}</option>`)].join("");
  document.querySelector("#mode-list").innerHTML = state.slots.map((slot) => {
    // Keep a non-DroidProxy or broken current value visible instead of silently replacing it.
    const keepCurrent = (slot.external || slot.missing)
      ? `<option value="__current__" selected>${escapeHtml(slot.missing ? `Missing: ${slot.current}` : `Keep: ${slot.current}`)}</option>`
      : "";
    const options = state.models.map((model) =>
      `<option value="${escapeHtml(model.id)}" ${!keepCurrent && model.id === slot.model ? "selected" : ""}>${escapeHtml(model.label)}</option>`).join("");
    return `
      <div class="mode-row ${slot.missing ? "missing" : ""}" data-slot="${escapeHtml(slot.key)}">
        <span class="routing-label">${escapeHtml(slot.label)}${slot.missing ? ` <span class="warn-badge" title="This model ID no longer exists in DroidProxy">broken</span>` : ""}</span>
        <div class="mode-selects">
          <select class="mode-model">${keepCurrent}<option value="" ${!keepCurrent && !slot.current ? "selected" : ""}>Factory default</option>${options}</select>
          <select class="mode-effort">${efforts(slot.effort)}</select>
        </div>
      </div>`;
  }).join("");
}

function collectModes() {
  const choices = {};
  document.querySelectorAll(".mode-row").forEach((row) => {
    const model = row.querySelector(".mode-model").value;
    if (model === "__current__") return;
    choices[row.dataset.slot] = { model, effort: row.querySelector(".mode-effort").value };
  });
  return choices;
}

async function refreshModes() {
  renderModes(await api.factoryModes());
}

async function refreshRouting() {
  renderRouting(await api.routing());
}

// Configured providers stay visible; the rest fold into "Other providers".
function renderApiProviders(providers) {
  const row = (provider) => apiProviderRow(provider);
  const configured = providers.filter((provider) => provider.configured);
  const others = providers.filter((provider) => !provider.configured);
  const wasOpen = document.querySelector("#other-api-providers")?.open;
  document.querySelector("#api-provider-list").innerHTML = configured.map(row).join("") + (others.length ? `
    <details id="other-api-providers" class="other-providers" ${wasOpen || !configured.length ? "open" : ""}>
      <summary>Other providers (${others.length})</summary>
      <div class="provider-list">${others.map(row).join("")}</div>
    </details>` : "");
}

function apiProviderRow(provider) {
  const regions = provider.regions.map((region) =>
    `<option value="${escapeHtml(region.key)}" ${region.key === provider.region ? "selected" : ""}>${escapeHtml(region.label)} · ${escapeHtml(region.residency)}</option>`).join("");
  return `
    <div class="provider api ${provider.configured ? "connected" : ""}" data-api="${escapeHtml(provider.key)}">
      <div class="provider-head">
        <img class="provider-logo" src="icons/${escapeHtml(provider.key)}.svg" alt="" />
        <span class="provider-name">${escapeHtml(provider.label)} <small>${escapeHtml(provider.models.join(", "))}</small></span>
      </div>
      <div class="api-controls">
        <select class="api-region">${regions}</select>
        <input class="api-key" type="password" placeholder="${provider.configured ? "Key saved (enter a new one to replace)" : "API key"}" autocomplete="off" spellcheck="false" />
        <button class="primary small api-save">Save</button>
        ${provider.configured ? `<button class="small api-clear">Remove</button>` : ""}
      </div>
      <div class="provider-accounts">
        ${provider.configured
          ? `<div class="authorized"><span class="auth-badge">Authorized</span><span class="auth-email">API key saved</span></div>`
          : `<div class="authorized none">No key</div>`}
      </div>
    </div>`;
}

async function refreshApiProviders() {
  renderApiProviders(await api.apiProviders());
}

// `results`: { title, windows, error, note }. API entries can carry both a
// balance error and token windows, so both are shown.
function renderUsage(results) {
  elements.usage.className = "list";
  elements.usage.innerHTML = results.map(({ title, windows, error, note }) => `
    <div class="usage-account">
      <div class="usage-account-title">${escapeHtml(title)}</div>
      ${error ? `<span class="muted">${escapeHtml(error)}</span>` : ""}
      ${windows.length ? renderUsageWindows(windows) : error ? "" : `<span class="muted">Usage response did not include quota windows.</span>`}
      ${note ? `<span class="usage-note">${escapeHtml(note)}</span>` : ""}
    </div>
  `).join("");
}

function renderUsageWindows(windows) {
  return windows.map((window) => {
    const remaining = typeof window.remainingPercent === "number" ? Math.round(window.remainingPercent) : null;
    const low = remaining !== null && remaining < 20;
    return `
      <div class="usage-window">
        <strong>${escapeHtml(window.title)}</strong>
        ${remaining === null ? (window.detail ? "" : "<span>Usage unavailable</span>") : `
          <div class="bar"><div class="bar-fill ${low ? "low" : ""}" style="width: ${remaining}%"></div></div>
          <span>${remaining}% left</span>
        `}
        ${window.resetText ? `<span> · resets ${escapeHtml(window.resetText)}</span>` : ""}
        ${window.detail ? `<span class="usage-detail">${escapeHtml(window.detail)}</span>` : ""}
      </div>
    `;
  }).join("");
}

function renderFactoryStatus(status) {
  elements.factoryStatus.textContent = status.installed ? "Applied" : "Not applied";
  elements.factoryStatus.classList.toggle("applied", status.installed);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function refreshAccounts() {
  const accounts = await api.accounts();
  renderAccounts(accounts);
  return accounts;
}

async function refreshUsage() {
  const accounts = currentAccounts.length ? currentAccounts : await refreshAccounts();
  // Expired Claude tokens are refreshed by the usage fetch, so only skip disabled ones.
  const usable = accounts.filter((item) => !item.disabled && item.hasAccessToken);
  elements.usage.className = "list muted";
  elements.usage.textContent = "Fetching usage limits...";
  const order = ["codex", "claude", "antigravity", "kimi"];
  usable.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
  const [subscriptions, apiResults] = await Promise.all([
    Promise.all(usable.map(async (account) => {
      const title = `${account.providerLabel} · ${account.email}`;
      try {
        return { title, windows: await api.usage(account.id) };
      } catch (error) {
        return { title, windows: [], error: cleanIpcError(error) };
      }
    })),
    api.apiUsage().catch(() => [])
  ]);
  const results = [
    ...subscriptions,
    ...apiResults.map((item) => ({ title: `${item.label} · API key`, windows: item.windows, error: item.error, note: item.note }))
  ];
  if (!results.length) {
    elements.usage.className = "list muted";
    elements.usage.textContent = "Connect an account or add an API key to display usage.";
    return;
  }
  renderUsage(results);
}

// Electron prefixes rejected IPC calls with "Error invoking remote method ...".
function cleanIpcError(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

async function toggleServer() {
  try {
    const state = await api.proxyState();
    renderProxyState(state.running ? await api.stopProxy() : await api.startProxy());
  } catch (error) {
    showToast(error.message || String(error));
  }
}

elements.toggleServer.addEventListener("click", toggleServer);

elements.debug.addEventListener("change", saveDebugLogging);

elements.copyEndpoint.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(elements.endpoint.textContent);
    showToast("Endpoint copied to clipboard.");
  } catch (error) {
    showToast("Could not copy endpoint.");
  }
});

document.querySelectorAll(".login-btn").forEach((button) => {
  button.addEventListener("click", async () => {
    const label = button.closest(".provider").querySelector(".provider-name").firstChild.textContent.trim();
    try {
      await api.login(button.dataset.provider);
      showToast(`Browser opened for ${label} login. Complete the sign-in, then refresh accounts.`);
      setTimeout(refreshAccounts, 2500);
    } catch (error) {
      showToast(error.message || String(error));
    }
  });
});

document.querySelector("#refresh-accounts-btn").addEventListener("click", refreshAccounts);
document.querySelector("#refresh-usage-btn").addEventListener("click", refreshUsage);
document.querySelector("#auth-folder-btn").addEventListener("click", () => api.openAuthFolder());
document.querySelector("#factory-folder-btn").addEventListener("click", () => api.openFactoryFolder());

document.querySelector("#apply-factory-btn").addEventListener("click", async () => {
  try {
    renderFactoryStatus(await api.applyFactory());
    showToast("Factory custom models updated. Restart Factory or open a new session to see them.");
  } catch (error) {
    showToast(error.message || String(error));
  }
});

document.querySelector("#clear-log-btn").addEventListener("click", () => {
  elements.logs.textContent = "";
});

async function saveRouting(message) {
  try {
    renderRouting(await api.saveRouting(collectRouting()));
    renderFactoryStatus(await api.factoryStatus());
    showToast(message);
  } catch (error) {
    showToast(cleanIpcError(error));
  }
}

document.querySelector("#save-routing-btn").addEventListener("click", () => saveRouting("Routing saved."));
document.querySelector("#save-balanced-btn").addEventListener("click", () => saveRouting("Balanced routing saved. New sessions use it."));
document.querySelector("#balanced-enabled").addEventListener("change", () => saveRouting("Balanced routing updated."));
document.querySelector("#auto-enabled").addEventListener("change", () =>
  saveRouting("Auto routing updated. Click Apply so Factory shows or hides DroidProxy: Auto."));
document.querySelector("#fallback-enabled").addEventListener("change", () => saveRouting("Backup models updated."));
document.querySelector("#reset-chains-btn").addEventListener("click", async () => {
  routing.fallbackChains = { ...routing.defaults.fallbackChains };
  routing.categoryModels = { ...routing.defaults.categoryModels };
  routing.roleModels = JSON.parse(JSON.stringify(routing.defaults.roleModels));
  renderRouting(routing);
  await saveRouting("Routing reset to defaults.");
});

document.querySelector("#recommended-modes-btn").addEventListener("click", () => {
  for (const slot of modes.slots) {
    const row = document.querySelector(`.mode-row[data-slot="${CSS.escape(slot.key)}"]`);
    const select = row.querySelector(".mode-model");
    if (![...select.options].some((option) => option.value === slot.recommended)) continue;
    select.value = slot.recommended;
  }
  showToast("Recommended Auto models selected. Click Apply to Factory to save.");
});

document.querySelector("#apply-modes-btn").addEventListener("click", async () => {
  try {
    renderModes(await api.applyFactoryModes(collectModes()));
    renderFactoryStatus(await api.factoryStatus());
    document.querySelector("#auto-enabled").checked = (await api.routing()).autoEnabled;
    showToast("Factory modes saved. Open a new Factory session to use them.");
  } catch (error) {
    showToast(cleanIpcError(error));
  }
});

document.querySelector("#api-provider-list").addEventListener("click", async (event) => {
  const row = event.target.closest(".provider.api");
  if (!row) return;
  const provider = row.dataset.api;
  try {
    if (event.target.classList.contains("api-save")) {
      const apiKey = row.querySelector(".api-key").value;
      const region = row.querySelector(".api-region").value;
      renderApiProviders(await api.setApiKey({ provider, apiKey, region }));
      showToast("API key saved. Click Apply to add its models to Factory.");
    } else if (event.target.classList.contains("api-clear")) {
      renderApiProviders(await api.clearApiKey(provider));
      showToast("API key removed. Click Apply to remove its models from Factory.");
    } else {
      return;
    }
    await Promise.all([refreshRouting(), refreshModes()]);
    renderFactoryStatus(await api.factoryStatus());
  } catch (error) {
    showToast(cleanIpcError(error));
  }
});

// Quota pills and cool-downs change on their own; refresh them without
// touching the editable routing fields.
setInterval(() => {
  if (routing) api.routing().then(renderCooling).catch(() => {});
}, 60 * 1000);

// Only the cool-down list is refreshed here, so unsaved routing edits survive.
api.onProxyState((state) => {
  renderProxyState(state);
  if (routing) api.routing().then(renderCooling).catch(() => {});
});
api.onLogs(renderLogs);
api.onAccountsChanged(() => refreshAccounts().then(refreshUsage));

async function boot() {
  setSettingsForm(await api.getSettings());
  renderProxyState(await api.proxyState());
  renderLogs(await api.getLogs());
  renderFactoryStatus(await api.factoryStatus());
  await refreshAccounts();
  await Promise.all([refreshRouting(), refreshApiProviders(), refreshModes()]);
  await refreshUsage();
}

boot().catch((error) => showToast(error.message || String(error)));
