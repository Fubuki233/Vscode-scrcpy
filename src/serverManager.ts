import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as net from 'net';

export class ServerManager {
    private process: cp.ChildProcess | null = null;
    private outputChannel: vscode.OutputChannel;
    private _port: number = 0;
    private _ready = false;
    private _generation = 0; // Prevents old exit handlers from corrupting state
    private _startPromise: Promise<void> | null = null;
    public onStatusChange: (() => void) | null = null;

    constructor(private extensionPath: string) {
        this.outputChannel = vscode.window.createOutputChannel('Web Scrcpy Server');
    }

    get port(): number { return this._port; }
    get serverUrl(): string { return `http://localhost:${this._port}`; }
    get isRunning(): boolean { return this._ready && this.process !== null; }

    async start(): Promise<void> {
        if (this.isRunning) return;
        // If already starting, return existing promise
        if (this._startPromise) return this._startPromise;

        this._startPromise = this._doStart();
        try {
            await this._startPromise;
        } finally {
            this._startPromise = null;
        }
    }

    private async _doStart(): Promise<void> {
        // Kill any old process first and wait briefly for cleanup
        this._killProcess();

        const gen = ++this._generation;
        this._port = await this._findFreePort();

        const isWin = process.platform === 'win32';
        const binName = isWin ? 'web-scrcpy-win-x64.exe' : 'web-scrcpy-linux-x64';
        const binPath = path.join(this.extensionPath, 'bin', binName);

        // Use bundled scrcpy-server and adb
        const serverJar = path.join(this.extensionPath, 'bin', 'scrcpy-server');
        const adbName = isWin ? 'adb.exe' : 'adb-linux-x64';
        const adbPath = path.join(this.extensionPath, 'bin', adbName);

        const args = [
            '--listen', `:${this._port}`,
            '--https', '',
            '--server-path', serverJar,
            '--adb', adbPath,
        ];

        this.outputChannel.appendLine(`[gen${gen}] Starting: ${binPath} --listen :${this._port}`);

        return new Promise<void>((resolve, reject) => {
            if (gen !== this._generation) { reject(new Error('Superseded')); return; }

            let proc: cp.ChildProcess;
            try {
                proc = cp.spawn(binPath, args, {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    env: { ...process.env },
                });
            } catch (e: any) {
                reject(new Error(`Spawn failed: ${e.message}`));
                return;
            }

            this.process = proc;
            this._ready = false;
            let settled = false;

            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    reject(new Error('Server start timeout (15s)'));
                }
            }, 15000);

            // Go's log package writes to stderr, so check BOTH streams
            const onData = (data: Buffer) => {
                const text = data.toString();
                this.outputChannel.append(text);
                if (!settled && text.includes('listening on')) {
                    settled = true;
                    clearTimeout(timeout);
                    if (gen === this._generation) {
                        this._ready = true;
                    }
                    resolve();
                }
            };
            proc.stdout?.on('data', onData);
            proc.stderr?.on('data', onData);

            proc.on('error', (err) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timeout);
                    reject(new Error(`Process error: ${err.message}`));
                }
            });

            proc.on('exit', (code) => {
                clearTimeout(timeout);
                this.outputChannel.appendLine(`[gen${gen}] Server exited (code ${code})`);
                // CRITICAL: Only update state if this exit belongs to the CURRENT generation
                if (gen === this._generation) {
                    this._ready = false;
                    this.process = null;
                    this.onStatusChange?.();
                }
                if (!settled) {
                    settled = true;
                    reject(new Error(`Server exited immediately (code ${code})`));
                }
            });
        });
    }

    private _killProcess(): void {
        if (this.process) {
            this.outputChannel.appendLine('Stopping server...');
            const proc = this.process;
            this.process = null;
            this._ready = false;
            // Remove all listeners so old exit handlers don't fire our callbacks
            proc.removeAllListeners('exit');
            proc.removeAllListeners('error');
            proc.stdout?.removeAllListeners('data');
            proc.stderr?.removeAllListeners('data');
            try { proc.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 3000);
        }
    }

    stop(): void {
        this._generation++; // Invalidate any in-progress start
        this._startPromise = null;
        this._killProcess();
    }

    showOutput(): void { this.outputChannel.show(); }

    dispose(): void {
        this.stop();
        this.outputChannel.dispose();
    }

    private _findFreePort(): Promise<number> {
        return new Promise((resolve, reject) => {
            const srv = net.createServer();
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address();
                if (addr && typeof addr !== 'string') {
                    const port = addr.port;
                    srv.close(() => resolve(port));
                } else {
                    srv.close(() => reject(new Error('Could not find free port')));
                }
            });
            srv.on('error', reject);
        });
    }
}
