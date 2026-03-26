import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { DeviceTreeProvider, DeviceItem } from './deviceTree';
import { ScrcpyPanel } from './scrcpyPanel';
import { ScrcpySidebarProvider } from './scrcpySidebar';
import { ServerManager } from './serverManager';

let deviceProvider: DeviceTreeProvider;
let sidebarProvider: ScrcpySidebarProvider;
let serverManager: ServerManager;
let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
    serverManager = new ServerManager(context.extensionPath);
    context.subscriptions.push({ dispose: () => serverManager.dispose() });

    // Status bar indicator
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusBarItem.command = 'vscode-scrcpy.showServerLog';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    updateStatusBar();

    // Auto-update status bar when server status changes (no auto-restart to prevent loops)
    serverManager.onStatusChange = () => {
        updateStatusBar();
    };

    const serverUrl = () => serverManager.serverUrl;

    deviceProvider = new DeviceTreeProvider(serverUrl);
    sidebarProvider = new ScrcpySidebarProvider(serverUrl);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ScrcpySidebarProvider.viewType, sidebarProvider, { webviewOptions: { retainContextWhenHidden: true } }),
    );
    const treeView = vscode.window.createTreeView('scrcpyDevices', {
        treeDataProvider: deviceProvider,
    });

    // Refresh every 5s
    const refreshInterval = setInterval(() => deviceProvider.refresh(), 5000);
    context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });

    // Auto-start embedded server
    serverManager.start().then(() => {
        updateStatusBar();
        deviceProvider.refresh();
    }).catch((err) => {
        updateStatusBar();
        vscode.window.showWarningMessage(`Failed to start server: ${err.message}`);
        serverManager.showOutput();
    });

    context.subscriptions.push(
        treeView,
        vscode.commands.registerCommand('vscode-scrcpy.showDevices', () => {
            deviceProvider.refresh();
        }),
        vscode.commands.registerCommand('vscode-scrcpy.setServer', () => {
            // No-op: kept for compatibility, server is always embedded
            serverManager.showOutput();
        }),
        vscode.commands.registerCommand('vscode-scrcpy.startServer', async () => {
            if (serverManager.isRunning) {
                vscode.window.showInformationMessage(`Server already running on port ${serverManager.port}`);
                return;
            }
            try {
                await serverManager.start();
                updateStatusBar();
                vscode.window.showInformationMessage(`Server started on port ${serverManager.port}`);
                deviceProvider.refresh();
            } catch (e: any) {
                updateStatusBar();
                vscode.window.showErrorMessage(`Failed to start server: ${e.message}`);
            }
        }),
        vscode.commands.registerCommand('vscode-scrcpy.stopServer', () => {
            serverManager.stop();
            updateStatusBar();
            vscode.window.showInformationMessage('Server stopped');
        }),
        vscode.commands.registerCommand('vscode-scrcpy.showServerLog', () => {
            serverManager.showOutput();
        }),
        vscode.commands.registerCommand('vscode-scrcpy.connectDevice', async (item: DeviceItem) => {
            if (!serverManager.isRunning) {
                vscode.window.showErrorMessage('Server not running. Use "Scrcpy: Start Server" first.');
                return;
            }
            const col = await pickViewColumn();
            if (col === undefined) return;
            if (col === SIDEBAR_COLUMN) {
                try {
                    const resp = await fetchAPI(serverUrl(), `/api/devices/${encodeURIComponent(item.serial)}/connect`, 'POST');
                    if (!resp.ok) throw new Error(await resp.text());
                    deviceProvider.refresh();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Connect failed: ${e.message}`);
                    return;
                }
                sidebarProvider.showDevice(item.serial, (item.label as string) || item.serial);
            } else {
                await connectAndView(context, serverUrl(), item.serial, col);
            }
        }),
        vscode.commands.registerCommand('vscode-scrcpy.viewDevice', async (item: DeviceItem) => {
            const col = await pickViewColumn();
            if (col === undefined) return;
            if (col === SIDEBAR_COLUMN) {
                sidebarProvider.showDevice(item.serial, (item.label as string) || item.serial);
            } else {
                ScrcpyPanel.createOrShow(context.extensionUri, serverUrl(), item.serial, item.label as string, col);
            }
        }),
        vscode.commands.registerCommand('vscode-scrcpy.disconnectDevice', async (item: DeviceItem) => {
            await disconnectDevice(serverUrl(), item.serial);
            deviceProvider.refresh();
        }),
        vscode.commands.registerCommand('vscode-scrcpy.connectIP', async () => {
            if (!serverManager.isRunning) {
                vscode.window.showErrorMessage('Server not running. Use "Scrcpy: Start Server" first.');
                return;
            }
            const addr = await vscode.window.showInputBox({
                prompt: 'Enter device IP:Port',
                placeHolder: '192.168.43.1:5555',
            });
            if (addr) {
                await adbConnect(serverUrl(), addr);
                deviceProvider.refresh();
            }
        }),
        vscode.commands.registerCommand('vscode-scrcpy.viewDeviceSidebar', async (item: DeviceItem) => {
            if (!item) return;
            if (!serverManager.isRunning) {
                vscode.window.showErrorMessage('Server not running. Use "Scrcpy: Start Server" first.');
                return;
            }
            // If device not connected yet, connect first
            if (!item.device.connected) {
                try {
                    const resp = await fetchAPI(serverUrl(), `/api/devices/${encodeURIComponent(item.serial)}/connect`, 'POST');
                    if (!resp.ok) throw new Error(await resp.text());
                    deviceProvider.refresh();
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Connect failed: ${e.message}`);
                    return;
                }
            }
            sidebarProvider.showDevice(item.serial, (item.label as string) || item.serial);
        }),
    );
}

// Special sentinel value meaning "open in sidebar"
const SIDEBAR_COLUMN = -99 as vscode.ViewColumn;

async function pickViewColumn(): Promise<vscode.ViewColumn | undefined> {
    const pick = await vscode.window.showQuickPick(
        [
            { label: '$(layout-sidebar-left) 侧边栏打开', description: 'Sidebar', value: SIDEBAR_COLUMN },
            { label: '$(split-horizontal) 编辑器旁边打开', description: 'Beside', value: vscode.ViewColumn.Beside },
            { label: '$(window) 当前编辑器打开', description: 'Active', value: vscode.ViewColumn.Active },
            { label: '$(layout-sidebar-right) 第二列打开', description: 'Two', value: vscode.ViewColumn.Two },
        ],
        { placeHolder: '选择打开位置' },
    );
    return pick?.value;
}

async function connectAndView(context: vscode.ExtensionContext, serverUrl: string, serial: string, column?: vscode.ViewColumn) {
    try {
        const resp = await fetchAPI(serverUrl, `/api/devices/${encodeURIComponent(serial)}/connect`, 'POST');
        if (!resp.ok) throw new Error(await resp.text());
        deviceProvider.refresh();
        ScrcpyPanel.createOrShow(context.extensionUri, serverUrl, serial, serial, column);
    } catch (e: any) {
        vscode.window.showErrorMessage(`Connect failed: ${e.message}`);
    }
}

async function disconnectDevice(serverUrl: string, serial: string) {
    try {
        await fetchAPI(serverUrl, `/api/devices/${encodeURIComponent(serial)}/disconnect`, 'POST');
    } catch (e: any) {
        vscode.window.showErrorMessage(`Disconnect failed: ${e.message}`);
    }
}

async function adbConnect(serverUrl: string, addr: string) {
    try {
        const resp = await fetchAPI(serverUrl, '/api/adb/connect', 'POST', { address: addr });
        if (!resp.ok) throw new Error(await resp.text());
        vscode.window.showInformationMessage(`Connected to ${addr}`);
    } catch (e: any) {
        vscode.window.showErrorMessage(`ADB connect failed: ${e.message}`);
    }
}

function fetchAPI(serverUrl: string, path: string, method: string = 'GET', body?: any): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<any> }> {
    return new Promise((resolve, reject) => {
        const url = new URL(path, serverUrl);
        const mod = url.protocol === 'https:' ? https : http;
        const postData = body ? JSON.stringify(body) : undefined;

        const options: https.RequestOptions = {
            method,
            rejectUnauthorized: false,
            headers: postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : undefined,
        };

        const req = mod.request(url, options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const ok = (res.statusCode || 500) >= 200 && (res.statusCode || 500) < 300;
                resolve({
                    ok,
                    status: res.statusCode || 500,
                    text: () => Promise.resolve(data),
                    json: () => Promise.resolve(JSON.parse(data)),
                });
            });
        });

        req.on('error', reject);
        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

function updateStatusBar() {
    if (serverManager.isRunning) {
        statusBarItem.text = `$(check) Scrcpy :${serverManager.port}`;
        statusBarItem.tooltip = `Scrcpy server running on port ${serverManager.port} — click to view log`;
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(error) Scrcpy offline`;
        statusBarItem.tooltip = 'Scrcpy server is not running — click to view log';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

export function deactivate() {
    if (serverManager) {
        serverManager.dispose();
    }
}
