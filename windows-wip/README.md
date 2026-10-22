# Droid Proxy for Windows

Electron-based Windows app that runs the bundled [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) backend (`cli-proxy-api.exe`) so [Factory](https://app.factory.ai) Droids can use your own Codex, Claude, and Gemini subscriptions as custom models.

## Features

- One-click OAuth login for Codex, Claude, and Gemini (via Google Antigravity).
- Usage limits per connected account: Codex and Claude 5-hour/weekly windows, Gemini quota groups.
- Applies DroidProxy custom models to `~/.factory/settings.json` (a timestamped backup is written first):
  - GPT 6 Astra, GPT 6.1 Sol, GPT 6 Luna
  - Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5
  - Gemini 3.8 Flash (High), Gemini 4 Argon (High)
- Starts the proxy automatically when the app opens.
- Closing the window hides it to the system tray and keeps the proxy running. Use the tray icon to reopen the window or **Quit**. Launching the exe again reopens the running instance instead of starting a second one.
- Logs are also written to `%USERPROFILE%\.cli-proxy-api\droidproxy-windows.log`.
- A small front proxy on the public port (default `8317`) applies the same Claude request fixes as the macOS app before forwarding to `cli-proxy-api` on the next port (`8318`):
  - Rewrites `Anthropic-Beta` so thinking stays visible and `fast-mode-*` never blocks account failover.
  - Strips stale assistant thinking blocks that Anthropic rejects on replay.

Gemini 4 Argon is only served to paid (non-trial) Google AI Pro/Ultra accounts.

## Install

There is no prebuilt release yet. Build the portable exe:

```powershell
git clone https://github.com/flyingdutchman101/droid-proxy-for-windows.git
cd droid-proxy-for-windows/windows-wip
npm install
npm run build:win
```

The app is written to `windows-wip/dist/DroidProxy Windows <version>.exe`. It is portable: run it from anywhere. Windows SmartScreen may warn on first launch because the exe is not signed with a trusted certificate.

## Usage

1. Open the app. The server starts on `127.0.0.1:8317`.
2. Click **Connect** for each provider you want and finish the sign-in in your browser.
3. Click **Apply** under Factory custom models, then restart Factory or open a new session.

Credentials are stored by CLIProxyAPI in `%USERPROFILE%\.cli-proxy-api`.

## Development

```powershell
npm install
npm start
npm run check
```

## Updating the backend

`resources/bin/cli-proxy-api.exe` is the official CLIProxyAPI Windows amd64 build (currently 8.0.38). To update it, download `CLIProxyAPI_<version>_windows_amd64.zip` from the [CLIProxyAPI releases](https://github.com/router-for-me/CLIProxyAPI/releases), verify it against that release's `checksums.txt`, and replace the exe.

## Credits

Fork of [nikships/droidproxy](https://github.com/nikships/droidproxy) (MIT). The macOS app in `../src` is unchanged from upstream.
