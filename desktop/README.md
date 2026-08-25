# DeepSeek Harness — Desktop Shell

A self-contained Windows desktop build of DeepSeek Harness: double-click the
app, and an Electron window opens the Web GUI. The app starts the `dsh web`
server itself, waits until the server is actually reachable, and only then
opens the window — so the UI never shows a connection-refused page, and no
separate server or browser tab is needed.

## How it works

The Electron main process (`main.js`):

1. Spawns the bundled server runtime as a child process:
   `dsh web --port 0 --no-open` — port `0` lets the OS assign a free port, so
   a busy/default port (e.g. 3080) can never block startup, and `--no-open`
   stops the server from opening a browser tab (the desktop owns its window).
2. Reads the child's stdout for the readiness line
   `dsh web: http://127.0.0.1:<port>`, then additionally polls that URL until
   it answers HTTP 200.
3. Only then creates the `BrowserWindow` and loads the URL.
4. If the server exits before becoming ready, or never answers, an error
   dialog shows the server log instead of a dead window.
5. Closing the window (or quitting) terminates the server process tree.
6. After the window opens, the shell checks npm for a newer `@deepseek-ai/dsh`
   on the `next` dist-tag and downloads it into a per-user staging directory;
   the update is activated on the next launch (or immediately if you choose
   "Restart now").

The server runs on Electron's own embedded Node via `ELECTRON_RUN_AS_NODE=1`
(`--expose-internals` is required by the harness's config-HMR watcher), so no
separate Node installation is needed.

User data (sessions, settings, credentials) lives in the standard
`$DSH_HOME` (default `~/.dsh`), exactly as with `dsh web` from the CLI.

## Shell behavior notes

- External http(s) links (chat markdown, terminal hyperlinks, plugin popups)
  open in the system browser; only pages served by the local dsh server stay
  inside the app window.
- Server stdout is consumed line by line with bounded buffering, so a
  long-running session does not grow shell memory.
- When the server fails to start or dies, the error dialog offers a
  safe-mode relaunch: one launch with every third-party plugin entry
  disabled. The profile's own `cordis.patch.yml` is backed up and
  temporarily extended with allowlist disable rows (the `web` subcommand
  rejects launcher-level `--patch`, so no overlay file is used); the backup
  is restored as soon as that launch opens its window.
- The page can declare active background work through the preload bridge
  (`window.desktopWindow.setCloseGuard(true)`); while set, closing the
  window asks for confirmation instead of killing the running server tree.
- While background work is active (server `tasks` events or the preload
  guard) the shell prevents system sleep and shows an indeterminate taskbar
  progress; both clear when work settles.
- `Ctrl/Cmd+Shift+H` summons the window. Login-at-startup follows
  `desktop.autostart` in the settings document (added the same way as
  `desktop.closeBehavior`).

Installed updates are fingerprinted (SHA-256 over the dsh artifacts) at staging and re-verified before activation; a mismatched staging directory is refused.\n\n## Auto-update

The check is wired into the shell itself (once per run, ~15s after the first window opens; delay/disable via `DSH_DESKTOP_UPDATE_DELAY_MS` / `DSH_DESKTOP_DISABLE_UPDATE`). Channel and registry are settings-driven with env fallbacks: `desktop.updateChannel` (default `next`) and `desktop.updateRegistry` fall back to `DSH_DESKTOP_UPDATE_CHANNEL` / `DSH_DESKTOP_REGISTRY`. When a newer dsh is staged, an OS notification announces it; fingerprints are recorded at staging and verified before activation.

After the window opens, the shell checks npm for a newer `@deepseek-ai/dsh`
version. By default it follows the `next` dist-tag (prerelease releases), which
is the tag the harness release pipeline uses for rc versions. When a newer
version is found, it is installed into a staging directory under the per-user
data directory (`%APPDATA%/DeepSeek Harness/runtime-next`) using the `npm`
command. The running session keeps the old runtime; once the download finishes
you can restart immediately or let it apply on the next launch. On the next
start the staged runtime is atomically moved to
`%APPDATA%/DeepSeek Harness/runtime` before the server is spawned.

Auto-update can be controlled with environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_DESKTOP_DISABLE_UPDATE` | unset | Set to `1` to disable the update check. |
| `DSH_DESKTOP_UPDATE_CHANNEL` | `next` | npm dist-tag to follow, e.g. `next` or `latest`. |
| `DSH_DESKTOP_NPM_CACHE` | `%APPDATA%/DeepSeek Harness/npm-cache` | npm cache directory for the update install. |
| `DSH_DESKTOP_NPM` | `npm` | npm command to run; useful when npm is not on `PATH`. |
| `DSH_DESKTOP_REGISTRY` | `https://registry.npmjs.org` | npm registry used for the version check and install. |

If `npm` is not available or the registry/network request fails, the current
runtime keeps working and the failure is logged; the check retries on the next
launch.

## Layout

```
desktop/
  main.js                    Electron main process (the shell)
  update.js                  dsh runtime auto-update (check/install/activate)
  package.json               shell manifest
  scripts/
    prepare-runtime.js       npm-installs the server runtime closure
    build.js                 assembles the distributable app folder
  runtime/                   generated: the dsh server closure (gitignored)
  dist/DeepSeek Harness/     generated: the app folder (gitignored)
```

## Build

```sh
cd desktop
npm install                       # installs Electron (binary via postinstall)
node scripts/prepare-runtime.js   # prepares the server runtime closure into runtime/
node scripts/build.js             # assembles dist/DeepSeek Harness/
```

Then double-click `dist/DeepSeek Harness/DeepSeek Harness.exe`.

A single-file portable exe is also available:

```sh
npx electron-builder --win portable --config electron-builder.config.cjs \
  --prepackaged "dist/DeepSeek Harness"
# → dist/installer/DeepSeek-Harness-0.1.0-portable.exe
```

The portable exe self-extracts to a temp folder on first launch, so startup
takes a little longer; the app folder build starts faster.

Mirror notes (slow/blocked GitHub): the Electron binary download can be
redirected with `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`,
`ELECTRON_CUSTOM_DIR={{ version }}`, and `electron_config_cache=<writable
cache dir>` before `npm install`. electron-builder's auxiliary binaries use
`ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

## Develop

```sh
cd desktop
npm start    # runs Electron against desktop/runtime in dev layout
```

`app.isPackaged` selects the runtime location: `desktop/runtime` in dev,
`<app>/resources/runtime` when packaged.
## Tests

Behavioral tests for the shell modules run with plain node (no Electron):

```sh
cd desktop
node tests/line-stream.test.cjs
node tests/safe-mode.test.cjs
node tests/notifier.test.cjs
node tests/settings-reader.test.cjs
node tests/main-integration.test.cjs
```

The integration test stubs Electron, child_process, and http to exercise the
spawn -> readiness -> smoke path, the safe-mode marker -> overlay -> `--patch`
wiring, and the close-guard bridge end to end.
