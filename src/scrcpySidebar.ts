import * as vscode from 'vscode';
import WebSocket from 'ws';

export class ScrcpySidebarProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'scrcpyPlayerView';

    private view: vscode.WebviewView | undefined;
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private connectTimeout: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 1000;
    private currentSerial: string | null = null;
    private pendingLabel: string | null = null;
    private serverUrlFn: () => string;
    private webviewReady = false;
    private generation = 0; // incremented on each showDevice to invalidate stale callbacks
    private pendingMessages = 0; // track inflight postMessage calls for backpressure

    constructor(serverUrlFn: () => string) {
        this.serverUrlFn = serverUrlFn;
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
        };

        // If showDevice was called before the view was resolved, load player directly
        if (this.currentSerial && this.pendingLabel !== null) {
            webviewView.webview.html = this.getPlayerHtml();
            this.view.title = `📱 ${this.pendingLabel}`;
            this.pendingLabel = null;
        } else {
            webviewView.webview.html = this.getIdleHtml();
        }

        webviewView.webview.onDidReceiveMessage(msg => {
            switch (msg.type) {
                case 'ready':
                    this.webviewReady = true;
                    if (this.currentSerial) {
                        this.connectWs();
                    }
                    break;
                case 'ws_send':
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(Buffer.from(msg.data, 'base64'));
                    }
                    break;
            }
        });

        webviewView.onDidDispose(() => {
            this.view = undefined;
            this.webviewReady = false;
            this.closeWs();
        });
    }

    public showDevice(serial: string, label: string) {
        this.closeWs();
        this.currentSerial = serial;
        this.webviewReady = false;
        this.reconnectDelay = 1000;
        this.generation++; // invalidate any pending callbacks from previous session

        if (!this.view) {
            // View not yet resolved — store pending info, resolveWebviewView will pick it up
            this.pendingLabel = label;
            vscode.commands.executeCommand('scrcpyPlayerView.focus');
            return;
        }

        this.pendingLabel = null;
        this.view.show?.(true);
        this.view.title = `📱 ${label}`;
        this.view.webview.html = this.getPlayerHtml();
        // WS will connect when webview sends 'ready'
    }

    private closeWs() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.connectTimeout) {
            clearTimeout(this.connectTimeout);
            this.connectTimeout = null;
        }
        if (this.ws) {
            try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
            this.ws = null;
        }
    }

    private connectWs() {
        if (!this.view || !this.currentSerial) return;
        this.closeWs();

        const gen = this.generation; // capture generation to detect stale callbacks
        const serverUrl = this.serverUrlFn();
        const proto = serverUrl.startsWith('https') ? 'wss' : 'ws';
        const host = serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `${proto}://${host}/ws/device/${encodeURIComponent(this.currentSerial)}`;

        const ws = new WebSocket(url, { rejectUnauthorized: false });
        this.ws = ws;

        // Connection timeout: if WS stays in CONNECTING for too long, force close and retry
        this.connectTimeout = setTimeout(() => {
            this.connectTimeout = null;
            if (gen !== this.generation) return;
            if (ws.readyState === WebSocket.CONNECTING) {
                try { ws.terminate(); } catch {}
            }
        }, 8000);

        ws.on('open', () => {
            if (this.connectTimeout) {
                clearTimeout(this.connectTimeout);
                this.connectTimeout = null;
            }
            if (gen !== this.generation) { try { ws.close(); } catch {} return; }
            this.reconnectDelay = 1000;
            this.view?.webview.postMessage({ type: 'ws_open' });
        });

        ws.on('message', (data: Buffer) => {
            if (gen !== this.generation || !this.view) return;
            // Drop video frames if the webview message queue is backing up
            const ch = data.length > 0 ? data[0] : 0;
            if (ch === 0x01 && this.pendingMessages > 30) return; // 0x01 = video channel
            this.pendingMessages++;
            const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data as ArrayBuffer).toString('base64');
            this.view.webview.postMessage({ type: 'ws_data', data: b64 }).then(
                () => { this.pendingMessages = Math.max(0, this.pendingMessages - 1); },
                () => { this.pendingMessages = Math.max(0, this.pendingMessages - 1); }
            );
        });

        ws.on('close', () => {
            if (gen !== this.generation) return; // stale session — don't reconnect
            this.view?.webview.postMessage({ type: 'ws_close' });
            if (this.view && this.currentSerial) {
                this.reconnectTimer = setTimeout(() => {
                    if (gen !== this.generation) return;
                    this.connectWs();
                }, this.reconnectDelay);
                this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000);
            }
        });

        ws.on('error', () => {});
    }

    private getIdleHtml(): string {
        return /*html*/`<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
body { background: #1e1e1e; color: #888; display: flex; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; font-size: 13px; text-align: center; }
</style>
</head><body>
<div>Select a device and click<br><strong>View in Sidebar</strong></div>
</body></html>`;
    }

    private getPlayerHtml(): string {
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   script-src 'unsafe-inline';
                   style-src 'unsafe-inline';
                   img-src data:;">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: #1e1e1e;
            color: #ccc;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            height: 100vh;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            user-select: none;
        }
        #nav-bar {
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 3px 4px;
            background: #252526;
            gap: 2px;
            flex-shrink: 0;
        }
        #nav-bar button {
            background: #333;
            color: #ccc;
            border: none;
            padding: 3px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            flex: 1;
        }
        #nav-bar button:hover { background: #444; }
        #status-line {
            display: flex;
            align-items: center;
            padding: 2px 6px;
            background: #1e1e1e;
            font-size: 10px;
            gap: 4px;
            flex-shrink: 0;
        }
        #status-line .dot { width: 6px; height: 6px; border-radius: 50%; }
        .dot.green { background: #4ec9b0; }
        .dot.red { background: #f44747; }

        #canvas-wrapper {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            position: relative;
        }
        canvas {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
        }
        .hidden { display: none !important; }
        #overlay {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            background: rgba(30,30,30,0.9);
            color: #888;
            font-size: 12px;
            z-index: 10;
        }
    </style>
</head>
<body>
    <div id="nav-bar">
        <button id="btn-back">←</button>
        <button id="btn-home">⊙</button>
        <button id="btn-recents">☰</button>
        <button id="btn-control">▶ Ctrl</button>
    </div>
    <div id="status-line">
        <span class="dot" id="conn-dot"></span>
        <span id="conn-text">Connecting...</span>
        <span style="flex:1"></span>
        <span id="info-text" style="font-size:9px"></span>
    </div>
    <div id="canvas-wrapper">
        <div id="overlay">Connecting...</div>
        <canvas id="canvas"></canvas>
    </div>

<script>
(function() {
    const vscode = acquireVsCodeApi();

    const CH_VIDEO = 0x01, CH_AUDIO = 0x02, CH_CONTROL = 0x03, CH_MGMT = 0x10;
    const PACKET_HEADER = 12;
    const FLAG_CONFIG = BigInt(1) << BigInt(63);
    const FLAG_KEY_FRAME = BigInt(1) << BigInt(62);
    const PTS_MASK = FLAG_KEY_FRAME - BigInt(1);

    const AKEY_DOWN = 0, AKEY_UP = 1;
    const AMOTION_DOWN = 0, AMOTION_UP = 1, AMOTION_MOVE = 2;
    const TOUCH_EVENT_MASK = 0xFFFFFFFF >>> 0;
    const MSG_INJECT_KEYCODE = 0;
    const MSG_INJECT_TOUCH = 2;
    const MSG_INJECT_SCROLL = 3;
    const MSG_BACK_OR_SCREEN_ON = 4;

    const canvas = document.getElementById('canvas');
    const overlay = document.getElementById('overlay');
    const connDot = document.getElementById('conn-dot');
    const connText = document.getElementById('conn-text');
    const infoText = document.getElementById('info-text');
    const ctx = canvas.getContext('2d');

    let connected = false;
    let deviceW = 0, deviceH = 0;
    let hasControl = false;
    let decoder = null;
    let spsData = null, ppsData = null;
    let frameCount = 0, pendingFrames = 0;
    let needKeyFrame = false;

    function b64ToU8(b64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
    }
    function u8ToB64(u8) {
        let bin = '';
        for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        return btoa(bin);
    }

    function parseNALUs(data) {
        const nalus = [];
        const len = data.length;
        let i = 0;
        while (i < len) {
            if (i + 2 < len && data[i] === 0 && data[i+1] === 0) {
                let scLen = 0;
                if (data[i+2] === 1) scLen = 3;
                else if (i+3 < len && data[i+2] === 0 && data[i+3] === 1) scLen = 4;
                if (scLen > 0) {
                    const start = i + scLen;
                    let end = len;
                    for (let j = start+1; j+2 < len; j++) {
                        if (data[j] === 0 && data[j+1] === 0 &&
                            (data[j+2] === 1 || (j+3 < len && data[j+2] === 0 && data[j+3] === 1))) {
                            end = j; break;
                        }
                    }
                    if (start < end) nalus.push(data.subarray(start, end));
                    i = end; continue;
                }
            }
            i++;
        }
        return nalus;
    }

    function buildAvcC(sps, pps) {
        const buf = new Uint8Array(6 + 2 + sps.length + 1 + 2 + pps.length);
        let o = 0;
        buf[o++] = 1; buf[o++] = sps[1]; buf[o++] = sps[2]; buf[o++] = sps[3];
        buf[o++] = 0xFF; buf[o++] = 0xE1;
        buf[o++] = (sps.length >> 8) & 0xFF; buf[o++] = sps.length & 0xFF;
        buf.set(sps, o); o += sps.length;
        buf[o++] = 1;
        buf[o++] = (pps.length >> 8) & 0xFF; buf[o++] = pps.length & 0xFF;
        buf.set(pps, o);
        return buf;
    }

    function nalusToAvcc(nalus) {
        let size = 0;
        for (const n of nalus) size += 4 + n.length;
        const buf = new Uint8Array(size);
        let o = 0;
        for (const n of nalus) {
            buf[o++] = (n.length >> 24) & 0xFF;
            buf[o++] = (n.length >> 16) & 0xFF;
            buf[o++] = (n.length >> 8) & 0xFF;
            buf[o++] = n.length & 0xFF;
            buf.set(n, o); o += n.length;
        }
        return buf;
    }

    function resetDecoder() {
        if (decoder && decoder.state !== 'closed') {
            try { decoder.close(); } catch {}
        }
        decoder = null;
        pendingFrames = 0;
    }

    function rebuildDecoder() {
        resetDecoder();
        if (!spsData || !ppsData || typeof window.VideoDecoder === 'undefined') return;
        const avcC = buildAvcC(spsData, ppsData);
        const codecString = 'avc1.'
            + spsData[1].toString(16).padStart(2, '0')
            + spsData[2].toString(16).padStart(2, '0')
            + spsData[3].toString(16).padStart(2, '0');
        decoder = new window.VideoDecoder({
            output: (frame) => {
                pendingFrames--;
                ctx.drawImage(frame, 0, 0);
                frame.close();
                frameCount++;
            },
            error: (e) => { connText.textContent = 'Decode error: ' + e.message; }
        });
        decoder.configure({
            codec: codecString,
            codedWidth: deviceW,
            codedHeight: deviceH,
            description: avcC,
            optimizeForLatency: true,
            hardwareAcceleration: 'prefer-hardware',
        });
    }

    function feedVideo(packet) {
        if (packet.length < PACKET_HEADER) return;
        const dv = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
        const ptsFlags = dv.getBigUint64(0, false);
        const packetLen = dv.getUint32(8, false);
        const isConfig = (ptsFlags & FLAG_CONFIG) !== BigInt(0);
        const isKey = (ptsFlags & FLAG_KEY_FRAME) !== BigInt(0);
        const pts = Number(ptsFlags & PTS_MASK);
        const rawData = packet.subarray(PACKET_HEADER, PACKET_HEADER + packetLen);
        const nalus = parseNALUs(rawData);
        if (nalus.length === 0) return;

        if (isConfig) {
            let newSps = null, newPps = null;
            for (const nalu of nalus) {
                const type = nalu[0] & 0x1F;
                if (type === 7) newSps = nalu;
                else if (type === 8) newPps = nalu;
            }
            if (newSps && newPps) {
                spsData = newSps;
                ppsData = newPps;
                rebuildDecoder();
            }
            return;
        }

        if (!decoder || decoder.state !== 'configured') return;
        if (decoder.decodeQueueSize > 10) {
            rebuildDecoder();
            needKeyFrame = true;
            sendMgmt({ type: 'request_keyframe' });
            return;
        }
        if (needKeyFrame && !isKey) return;
        if (needKeyFrame && isKey) needKeyFrame = false;

        const avccData = nalusToAvcc(nalus);
        pendingFrames++;
        decoder.decode(new window.EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: pts,
            data: avccData,
        }));
    }

    function initDecoder(codec, w, h) {
        deviceW = w; deviceH = h;
        canvas.width = w; canvas.height = h;
        updateSize();
        if (typeof window.VideoDecoder === 'undefined') {
            connText.textContent = 'WebCodecs unavailable';
        }
    }

    window.addEventListener('message', (event) => {
        const msg = event.data;
        switch (msg.type) {
            case 'ws_open':
                connected = true;
                connDot.className = 'dot green';
                connText.textContent = 'Connected';
                overlay.classList.add('hidden');
                sendMgmt({ type: 'request_control' });
                break;
            case 'ws_close':
                connected = false;
                connDot.className = 'dot red';
                connText.textContent = 'Disconnected';
                overlay.textContent = 'Reconnecting...';
                overlay.classList.remove('hidden');
                hasControl = false;
                updateControlBtn();
                break;
            case 'ws_data': {
                const data = b64ToU8(msg.data);
                if (data.length < 2) break;
                const ch = data[0];
                const payload = data.slice(1);
                switch (ch) {
                    case CH_VIDEO: feedVideo(payload); break;
                    case CH_MGMT:
                        try {
                            const m = JSON.parse(new TextDecoder().decode(payload));
                            handleMgmt(m);
                        } catch {}
                        break;
                }
                break;
            }
        }
    });

    function sendToHost(u8array) {
        vscode.postMessage({ type: 'ws_send', data: u8ToB64(u8array) });
    }
    function sendControl(buf) {
        if (!connected) return;
        const frame = new Uint8Array(1 + buf.length);
        frame[0] = CH_CONTROL;
        frame.set(buf, 1);
        sendToHost(frame);
    }
    function sendMgmt(obj) {
        if (!connected) return;
        const json = new TextEncoder().encode(JSON.stringify(obj));
        const frame = new Uint8Array(1 + json.length);
        frame[0] = CH_MGMT;
        frame.set(json, 1);
        sendToHost(frame);
    }
    function handleMgmt(msg) {
        switch (msg.type) {
            case 'device_info':
                deviceW = msg.width; deviceH = msg.height;
                initDecoder(msg.video_codec, msg.width, msg.height);
                infoText.textContent = msg.width + '×' + msg.height;
                break;
            case 'control_granted':
                hasControl = msg.granted;
                updateControlBtn();
                break;
            case 'control_released':
                hasControl = false;
                updateControlBtn();
                break;
        }
    }

    function serializeKeycode(action, keycode, repeat, metaState) {
        const buf = new Uint8Array(14);
        const dv = new DataView(buf.buffer);
        buf[0] = MSG_INJECT_KEYCODE;
        dv.setUint8(1, action);
        dv.setUint32(2, keycode, false);
        dv.setUint32(6, repeat, false);
        dv.setUint32(10, metaState, false);
        return buf;
    }
    function serializeBackOrScreenOn(action) {
        const buf = new Uint8Array(2);
        buf[0] = MSG_BACK_OR_SCREEN_ON;
        buf[1] = action;
        return buf;
    }
    function serializeScroll(x, y, w, h, hscroll, vscroll) {
        const buf = new Uint8Array(21);
        const dv = new DataView(buf.buffer);
        buf[0] = MSG_INJECT_SCROLL;
        dv.setInt32(1, x, false);
        dv.setInt32(5, y, false);
        dv.setUint16(9, w, false);
        dv.setUint16(11, h, false);
        dv.setInt16(13, Math.round(Math.max(-1, Math.min(1, hscroll)) * 0x7FFF), false);
        dv.setInt16(15, Math.round(Math.max(-1, Math.min(1, vscroll)) * 0x7FFF), false);
        dv.setUint32(17, 0, false);
        return buf;
    }
    function serializeTouch(action, pointerId, x, y, w, h, pressure) {
        const buf = new Uint8Array(32);
        const dv = new DataView(buf.buffer);
        buf[0] = MSG_INJECT_TOUCH;
        dv.setUint8(1, action);
        dv.setUint32(2, 0, false);
        dv.setUint32(6, pointerId & TOUCH_EVENT_MASK, false);
        dv.setInt32(10, x, false);
        dv.setInt32(14, y, false);
        dv.setUint16(18, w, false);
        dv.setUint16(20, h, false);
        dv.setUint16(22, pressure, false);
        dv.setUint32(24, action === AMOTION_DOWN ? 1 : 0, false);
        dv.setUint32(28, action === AMOTION_UP ? 0 : 1, false);
        return buf;
    }
    function getDevicePos(e) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: Math.round((e.clientX - rect.left) * deviceW / rect.width),
            y: Math.round((e.clientY - rect.top) * deviceH / rect.height),
        };
    }

    let mouseDown = false;
    canvas.addEventListener('mousedown', (e) => {
        if (!hasControl) return;
        e.preventDefault(); mouseDown = true;
        const p = getDevicePos(e);
        sendControl(serializeTouch(AMOTION_DOWN, 0xFFFFFFFE, p.x, p.y, deviceW, deviceH, 0xFFFF));
    });
    canvas.addEventListener('mousemove', (e) => {
        if (!hasControl || !mouseDown) return;
        e.preventDefault();
        const p = getDevicePos(e);
        sendControl(serializeTouch(AMOTION_MOVE, 0xFFFFFFFE, p.x, p.y, deviceW, deviceH, 0xFFFF));
    });
    canvas.addEventListener('mouseup', (e) => {
        if (!hasControl) return;
        e.preventDefault(); mouseDown = false;
        const p = getDevicePos(e);
        sendControl(serializeTouch(AMOTION_UP, 0xFFFFFFFE, p.x, p.y, deviceW, deviceH, 0));
    });
    canvas.addEventListener('mouseleave', (e) => {
        if (mouseDown) {
            mouseDown = false;
            const p = getDevicePos(e);
            sendControl(serializeTouch(AMOTION_UP, 0xFFFFFFFE, p.x, p.y, deviceW, deviceH, 0));
        }
    });
    canvas.addEventListener('touchstart', (e) => {
        if (!hasControl) return; e.preventDefault();
        for (const t of e.changedTouches) { const p = getDevicePos(t); sendControl(serializeTouch(AMOTION_DOWN, t.identifier, p.x, p.y, deviceW, deviceH, 0xFFFF)); }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        if (!hasControl) return; e.preventDefault();
        for (const t of e.changedTouches) { const p = getDevicePos(t); sendControl(serializeTouch(AMOTION_MOVE, t.identifier, p.x, p.y, deviceW, deviceH, 0xFFFF)); }
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
        if (!hasControl) return; e.preventDefault();
        for (const t of e.changedTouches) { const p = getDevicePos(t); sendControl(serializeTouch(AMOTION_UP, t.identifier, p.x, p.y, deviceW, deviceH, 0)); }
    }, { passive: false });
    canvas.addEventListener('wheel', (e) => {
        if (!hasControl) return; e.preventDefault();
        const p = getDevicePos(e);
        sendControl(serializeScroll(p.x, p.y, deviceW, deviceH, -Math.sign(e.deltaX), -Math.sign(e.deltaY)));
    }, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    function updateSize() {
        if (!deviceW || !deviceH) return;
        const wrapper = document.getElementById('canvas-wrapper');
        const rect = wrapper.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return;
        const aspect = deviceW / deviceH;
        let w, h;
        if (rect.width / rect.height > aspect) { h = rect.height; w = h * aspect; }
        else { w = rect.width; h = w / aspect; }
        canvas.style.width = Math.max(1, w) + 'px';
        canvas.style.height = Math.max(1, h) + 'px';
    }
    // ResizeObserver reliably detects sidebar layout changes (window.resize often misses them)
    new ResizeObserver(() => updateSize()).observe(document.getElementById('canvas-wrapper'));
    window.addEventListener('resize', updateSize);

    function updateControlBtn() {
        document.getElementById('btn-control').textContent = hasControl ? '⏸ Ctrl' : '▶ Ctrl';
    }
    document.getElementById('btn-control').addEventListener('click', () => {
        if (hasControl) { sendMgmt({ type: 'release_control' }); hasControl = false; }
        else { sendMgmt({ type: 'request_control' }); }
        updateControlBtn();
    });
    document.getElementById('btn-back').addEventListener('click', () => {
        if (!hasControl) return;
        sendControl(serializeBackOrScreenOn(AKEY_DOWN));
        setTimeout(() => sendControl(serializeBackOrScreenOn(AKEY_UP)), 50);
    });
    document.getElementById('btn-home').addEventListener('click', () => {
        if (!hasControl) return;
        sendControl(serializeKeycode(AKEY_DOWN, 3, 0, 0));
        setTimeout(() => sendControl(serializeKeycode(AKEY_UP, 3, 0, 0)), 50);
    });
    document.getElementById('btn-recents').addEventListener('click', () => {
        if (!hasControl) return;
        sendControl(serializeKeycode(AKEY_DOWN, 187, 0, 0));
        setTimeout(() => sendControl(serializeKeycode(AKEY_UP, 187, 0, 0)), 50);
    });

    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
