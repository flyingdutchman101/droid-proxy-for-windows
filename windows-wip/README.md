# VeryCuteDroidProxy (Droid Proxy for Windows)

Electron-based Windows app that runs the bundled [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) backend (`cli-proxy-api.exe`) so [Factory](https://app.factory.ai) Droids can use your own Codex, Claude, Gemini, and Kimi subscriptions, plus pay-per-token API keys, as custom models.

## Features

- One-click OAuth login for Codex, Claude, Gemini (via Google Antigravity), and Kimi Code. Each connected account is listed under its provider as **Authorized**.
- API keys for DeepSeek, Qwen Cloud, Kimi API (Moonshot), GLM (Z.ai), MiniMax, Mistral (EU endpoint available), and OpenRouter. Keys are encrypted with Windows DPAPI; their models get a provider prefix (for example `deepseek/deepseek-v4-pro`). Configured providers are listed first and the rest are folded away. China-hosted endpoints process your code in China.
  - Qwen Cloud **Token Plan** keys (`sk-sp-`) are detected and sent to `token-plan.maas.qwencloudapi.com`, which also serves GLM-5.3 and DeepSeek V4 Pro. Pay-as-you-go keys use the region endpoints. Qwen Cloud's Token Plan terms restrict it to interactive tool use and forbid automation or batch use, so keep it out of unattended Missions.
- **Auto routing:** pick **DroidProxy: Auto** in Factory. A fast model (Haiku 5.5, then Gemini 3.8 Flash, then GPT 6 Luna) classifies the first message of each session as coding, legal, business, writing, research, math, or quick, and the session stays on the model chosen for that category. Defaults come from independent leaderboards (Vals AI, Arena) and are editable in the app.
- **Balanced routing** (on by default): each Auto session picks, within its pool (the task type's model plus its backups, or a role's Model / Backup / Backup 2), the model whose plan is furthest **ahead of its weekly pace**: % left in the weekly/monthly window minus % of that window's time left. A plan with 36% left and 2 hours to reset (+35) goes before one with 87% left and 5 days to go (+16), so quota that would reset unused is spent first and plans running behind are saved. A plan whose 5-hour window is nearly empty is skipped. Quotas are read every 10 minutes. Sessions are re-checked on the next user message every 15 minutes, sessions that started as "quick" are re-classified once real work arrives, and a session that hits a limit stays on the backup that served it. When every plan in the pool is below the overflow threshold (default 35% left) and none is ahead of pace, the session goes to pay-per-token overflow models: Qwen3.8 Max, GLM-5.3 and DeepSeek V4 Pro for normal sessions, DeepSeek V4 Pro only for Missions (Qwen's Token Plan terms forbid automation).
- **Pace boost:** while a plan is ahead of pace by 15 points or more (and its 5-hour window has headroom), sessions on it move up to its strongest model (Luna → Sol → Astra, Haiku → Sonnet → Opus, Gemini Flash → Argon, Opus → Fable except for coding; quick tasks one step) and run at the model's maximum reasoning effort (the effort and thinking budget already in the request are raised; quick tasks keep normal effort). The margin and the effort boost are editable. The quota pills show each plan's weekly %, time to reset, and points vs pace.
- **Premium model:** normal Auto sessions for legal, business, and math use Claude Fable 5.1 while its Claude quota is at least 60% (LegalBench and EMB leader, but 2.5x Opus cost on the same quota); otherwise the balanced pool decides and Fable stays as a backup. Model, threshold, and task types are editable.
- **Mission roles:** **Auto · Orchestrator**, **Auto · Worker**, and **Auto · Validator** pick a model per task type and role (strong planner, fast executor, independent reviewer from a different model family), each with its own backup.
- **Factory modes:** set the model and reasoning effort for normal sessions, spec mode, and each Mission role from the app (`sessionDefaultSettings.model` / `specModeModel`, `missionOrchestratorModel`, `missionModelSettings.workerModel` / `validationWorkerModel`). "Use recommended" fills in the Auto models; broken model IDs are flagged.
- **Backup models:** when a model returns 429/503/529 before any output, the same request is retried on the next model in its backup list, across providers, and the exhausted model is skipped until it cools down (Retry-After, or 10 minutes). A tray notification says which model took over.
- Usage limits per connected account: Codex and Claude 5-hour/weekly windows, Gemini quota groups. For API keys: the DeepSeek account balance, plus input/output tokens per model counted from responses that pass through DroidProxy (stored in `%USERPROFILE%\.cli-proxy-api\droidproxy-windows-api-usage.json`). Qwen Cloud has no usage API for API keys, so Qwen shows these counts with a pointer to the console.
- **Voice & video:** generate speech (Gemini 3.8 Flash TTS and Flash-Lite TTS, 30 voices, optional style) and video with sound (Gemini Omni 1.1 Flash, 16:9 or 9:16, 360p to 4K) from the app. These are Gemini API models, not part of the Google AI Pro/Ultra sign-in, so they use a separate Google AI Studio API key (encrypted like the others). Speech has a free tier; video is paid only (about $0.10 per second at 720p) and asks for confirmation each time. Files are saved to `Documents\VeryCuteDroidProxy`. Veo was retired from the Gemini API on Oct 22, 2026.
  - **Veo 3.1 on your Google AI Pro/Ultra plan (no key):** Google offers Veo for plan credits only in Flow and the Gemini app, with no API. **Copy prompt & open Flow** (or **Open Gemini app**) copies the prompt, opens the site in your default browser, and for 3 hours copies every new `.mp4` you download into `Documents\VeryCuteDroidProxy` and shows it in the card. The originals stay in Downloads.
- Applies DroidProxy custom models to `~/.factory/settings.json` (a timestamped backup is written first):
  - Auto
  - GPT 6 Astra, GPT 6.1 Sol, GPT 6.1 Terra, GPT 6 Luna
  - Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5
  - Gemini 3.8 Flash (High), Gemini 4 Argon (High)
  - Claude Opus 5.5 (High) and Sonnet 5.5 (High) via Google, billed to Google AI Pro/Ultra
  - Kimi K3, Kimi K2.6 (Kimi Code)
  - Models for every API-key provider you configure
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

The app is written to `windows-wip/dist/VeryCuteDroidProxy <version>.exe`. It is portable: run it from anywhere. Windows SmartScreen may warn on first launch because the exe is not signed with a trusted certificate.

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
npm run icon   # re-render resources/icon.png and icon.ico from resources/icon.svg
```

## Updating the backend

`resources/bin/cli-proxy-api.exe` is the official CLIProxyAPI Windows amd64 build (currently 8.0.51). To update it, download `CLIProxyAPI_<version>_windows_amd64.zip` from the [CLIProxyAPI releases](https://github.com/router-for-me/CLIProxyAPI/releases), verify it against that release's `checksums.txt`, and replace the exe.

## Credits

Fork of [nikships/droidproxy](https://github.com/nikships/droidproxy) (MIT). The macOS app in `../src` is unchanged from upstream.

API provider logos in `src/renderer/icons/` (DeepSeek, Qwen, Moonshot, Z.ai, MiniMax, Mistral, OpenRouter) are from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT). Logos are trademarks of their respective owners.
