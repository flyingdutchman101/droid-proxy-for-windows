const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("droidProxy", {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  startProxy: () => ipcRenderer.invoke("proxy:start"),
  stopProxy: () => ipcRenderer.invoke("proxy:stop"),
  proxyState: () => ipcRenderer.invoke("proxy:state"),
  getLogs: () => ipcRenderer.invoke("logs:get"),
  login: (provider) => ipcRenderer.invoke("auth:login", provider),
  accounts: () => ipcRenderer.invoke("auth:accounts"),
  usage: (accountId) => ipcRenderer.invoke("usage:fetch", accountId),
  factoryStatus: () => ipcRenderer.invoke("factory:status"),
  applyFactory: () => ipcRenderer.invoke("factory:apply"),
  openAuthFolder: () => ipcRenderer.invoke("paths:openAuth"),
  openFactoryFolder: () => ipcRenderer.invoke("paths:openFactory"),
  routing: () => ipcRenderer.invoke("routing:get"),
  saveRouting: (routing) => ipcRenderer.invoke("routing:save", routing),
  apiProviders: () => ipcRenderer.invoke("apikeys:list"),
  setApiKey: (entry) => ipcRenderer.invoke("apikeys:set", entry),
  clearApiKey: (provider) => ipcRenderer.invoke("apikeys:clear", provider),
  onProxyState: (callback) => ipcRenderer.on("state:proxy", (_event, state) => callback(state)),
  onLogs: (callback) => ipcRenderer.on("state:logs", (_event, logs) => callback(logs)),
  onAccountsChanged: (callback) => ipcRenderer.on("state:accountsChanged", () => callback())
});
