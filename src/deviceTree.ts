import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';

interface DeviceStatus {
    serial: string;
    model: string;
    adb_state: string;
    conn_type: string;
    connected: boolean;
    info?: {
        DeviceName: string;
        VideoWidth: number;
        VideoHeight: number;
    };
}

export class DeviceItem extends vscode.TreeItem {
    constructor(
        public readonly serial: string,
        public readonly device: DeviceStatus,
    ) {
        const label = device.model || device.serial;
        super(label, vscode.TreeItemCollapsibleState.None);

        const connIcon = device.conn_type === 'usb' ? '🔌' : '📶';
        const stateIcon = device.connected ? '🟢' : (device.adb_state === 'device' ? '⚪' : '🔴');
        this.description = `${stateIcon} ${connIcon} ${device.conn_type.toUpperCase()} · ${device.adb_state}`;

        if (device.info) {
            this.description += ` · ${device.info.VideoWidth}×${device.info.VideoHeight}`;
        }

        this.tooltip = `Serial: ${device.serial}\nState: ${device.adb_state}\nType: ${device.conn_type}`;

        if (device.adb_state !== 'device') {
            this.contextValue = 'device_offline';
        } else if (device.connected) {
            this.contextValue = 'device_connected';
        } else {
            this.contextValue = 'device_available';
        }
    }
}

export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceItem> {
    private _onDidChange = new vscode.EventEmitter<DeviceItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    private devices: DeviceStatus[] = [];

    constructor(private serverUrl: () => string) {
        this.refresh();
    }

    refresh() {
        this.fetchDevices().then(devices => {
            this.devices = devices;
            this._onDidChange.fire(undefined);
        }).catch(() => {
            // silent
        });
    }

    getTreeItem(element: DeviceItem): vscode.TreeItem {
        return element;
    }

    getChildren(): DeviceItem[] {
        return this.devices.map(d => new DeviceItem(d.serial, d));
    }

    private async fetchDevices(): Promise<DeviceStatus[]> {
        return new Promise((resolve) => {
            try {
                const url = new URL('/api/devices', this.serverUrl());
                const mod = url.protocol === 'https:' ? https : http;
                const req = mod.get(url, { rejectUnauthorized: false }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data) as DeviceStatus[]);
                        } catch {
                            resolve([]);
                        }
                    });
                });
                req.on('error', () => resolve([]));
                req.end();
            } catch {
                resolve([]);
            }
        });
    }
}
