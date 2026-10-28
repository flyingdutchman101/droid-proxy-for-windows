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
          </div>
        </div>`;
    }).join("");
    return `
      <div class="category-block" title="${escapeHtml(category.description)}">
        <div class="routing-row">
          <span class="routing-label category-name">${escapeHtml(category.key[0].toUpperCase() + category.key.slice(1))}</span>
          ${modelSelect(`cat-${category.key}`, state.categoryModels[category.key], false)}
        </div>
        <div class="role-head"><span></span><span>Model</span><span>Backup</span></div>
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

  renderCooling(state);
}

function renderCooling(state) {
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
    const [model, backup] = [...row.querySelectorAll("select")].map((select) => select.value);
    roleModels[row.dataset.category] = roleModels[row.dataset.category] || {};
    roleModels[row.dataset.category][row.dataset.role] = { model, backup: backup === model ? "" : backup };
  });
  return {
    autoEnabled: document.querySelector("#auto-enabled").checked,
    fallbackEnabled: document.querySelector("#fallback-enabled").checked,
    categoryModels,
    roleModels,
    fallbackChains
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

function renderApiProviders(providers) {
  document.querySelector("#api-provider-list").innerHTML = providers.map((provider) => {
    const regions = provider.regions.map((region) =>
      `<option value="${escapeHtml(region.key)}" ${region.key === provider.region ? "selected" : ""}>${escapeHtml(region.label)} · ${escapeHtml(region.residency)}</option>`).join("");
    return `
      <div class="provider api" data-api="${escapeHtml(provider.key)}">
        <div class="provider-head">
          <span class="provider-logo monogram">${escapeHtml(provider.label[0])}</span>
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
  }).join("");
}

async function refreshApiProviders() {
  renderApiProviders(await api.apiProviders());
}

function renderUsage(results) {
  elements.usage.className = "list";
  elements.usage.innerHTML = results.map(({ account, windows, error }) => `
    <div class="usage-account">
      <div class="usage-account-title">${escapeHtml(account.providerLabel)} · ${escapeHtml(account.email)}</div>
      ${error ? `<span class="muted">${escapeHtml(error)}</span>`
        : windows.length ? renderUsageWindows(windows)
        : `<span class="muted">Usage response did not include quota windows.</span>`}
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
        ${remaining === null ? "<span>Usage unavailable</span>" : `
          <div class="bar"><div class="bar-fill ${low ? "low" : ""}" style="width: ${remaining}%"></div></div>
          <span>${remaining}% left</span>
        `}
        ${window.resetText ? `<span> · resets ${escapeHtml(window.resetText)}</span>` : ""}
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
  if (!usable.length) {
    elements.usage.className = "list muted";
    elements.usage.textContent = "Connect an account to display quota windows.";
    return;
  }

  elements.usage.className = "list muted";
  elements.usage.textContent = "Fetching usage limits...";
  const order = ["codex", "claude", "antigravity", "kimi"];
  usable.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
  renderUsage(await Promise.all(usable.map(async (account) => {
    try {
      return { account, windows: await api.usage(account.id) };
    } catch (error) {
      return { account, windows: [], error: cleanIpcError(error) };
    }
  })));
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
