# Vscode-scrcpy

Mirror and control your Android device directly inside VS Code — powered by [ScrHub](https://github.com/Fubuki233/scrhub).

## Features

- **Real-time screen mirroring** — H.264 decoded via WebCodecs, rendered in a webview
- **Full input control** — Mouse, touch, keyboard, scroll events sent back to device
- **Audio forwarding** — Opus audio playback
- **Embedded server** — ScrHub binary bundled and auto-started, zero manual setup
- **Two viewing modes** — Full editor panel or compact sidebar player
- **Device tree** — Activity bar sidebar showing all connected devices with inline actions
- **WiFi connect** — Connect to devices by IP address
- **Remote-SSH compatible** — WebSocket relay bridges the remote extension host to local webview

## How It Works

```
┌─────────────────┐        ┌──────────────────────┐        ┌───────────────┐
│ Android Device  │◄──────►│ Extension Host (Node) │◄──────►│  VS Code UI   │
│                 │  ADB   │  ScrHub (Go server)   │  WS    │  (Webview)    │
│                 │        │  WebSocket relay       │ relay  │  WebCodecs    │
└─────────────────┘        └──────────────────────┘        └───────────────┘
```

When activated, the extension:
1. Starts the bundled ScrHub server on the extension host
2. Lists available Android devices via ADB
3. On "Connect & View", starts an scrcpy session on the device
4. Opens a WebSocket connection and relays video/audio/control packets between the server and the VS Code webview
5. The webview decodes H.264 frames with WebCodecs and renders to canvas

This architecture works seamlessly over **Remote-SSH** — the server and ADB run on the remote machine, while the webview renders locally in your VS Code window.

## Installation

### VS Code Marketplace

Search for **"ScrHub"** in the Extensions view, or install from the [Marketplace page](https://marketplace.visualstudio.com/items?itemName=scrcpy-vscode.scrhub).

### GitHub Releases

Download a `.vsix` file for your platform from [Releases](https://github.com/Fubuki233/Vscode-scrcpy/releases), then:

```
code --install-extension scrhub-<platform>.vsix
```

## Requirements

- **Android device** with USB debugging enabled
- **ADB** accessible on the machine running VS Code (bundled in release packages)
- **VS Code** 1.80+

## Usage

1. Connect your Android device via USB
2. Open the **Android Devices** panel in the Activity Bar (phone icon)
3. Your device will appear in the device tree
4. Click **Connect & View** to start mirroring
5. Use **View in Sidebar** for a compact player in the sidebar

### WiFi / Hotspot

Click the plug icon (➕) in the device tree title bar, enter `<device-ip>:5555`, and connect wirelessly.

## Commands

| Command | Description |
|---------|-------------|
| `Scrcpy: Refresh Devices` | Refresh the device list |
| `Scrcpy: Set Server URL` | Configure custom server URL |
| `Scrcpy: Connect Device by IP` | Connect a device over WiFi/TCP |
| `Scrcpy: Start Server` | Manually start the ScrHub server |
| `Scrcpy: Stop Server` | Stop the ScrHub server |
| `Scrcpy: Show Server Log` | Show server output in a terminal |
| `Connect & View` | Start scrcpy session and open player |
| `View` | Open player for an already-connected device |
| `View in Sidebar` | Open player in the sidebar panel |
| `Disconnect` | Stop the scrcpy session |

## Building from Source

```bash
git clone https://github.com/Fubuki233/Vscode-scrcpy.git
cd Vscode-scrcpy
npm install
npm run compile

# Place these in the project root:
# - scrhub (or scrhub.exe) — from https://github.com/Fubuki233/scrhub/releases
# - scrcpy-server — from https://github.com/Genymobile/scrcpy/releases
# - adb (or adb.exe)

# Package as VSIX
npx @vscode/vsce package --no-dependencies
```

## Related Projects

- [ScrHub](https://github.com/Fubuki233/scrhub) — The Go server powering this extension
- [scrcpy](https://github.com/Genymobile/scrcpy) — The Android screen mirroring tool

## License

Apache License 2.0
