import * as vscode from 'vscode';
import WebSocket from 'ws';

export class ScrcpyPanel {
    public static currentPanels: Map<string, ScrcpyPanel> = new Map();
    private static readonly viewType = 'scrcpyPlayer';

    private readonly panel: vscode.WebviewPanel;
    private readonly serverUrl: string;
    private readonly serial: string;
    private disposed = false;
    private ws: WebSocket | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private connectTimeout: ReturnType<typeof setTimeout> | null = null;
    private reconnectDelay = 1000;
    private pendingMessages = 0;

    public static createOrShow(extensionUri: vscode.Uri, serverUrl: string, serial: string, label: string, column?: vscode.ViewColumn) {
        const existing = ScrcpyPanel.currentPanels.get(serial);
        if (existing) {
            existing.panel.reveal(column);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            ScrcpyPanel.viewType,
            `📱 ${label}`,
            column || vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [extensionUri],
            },
        );

        const scrcpyPanel = new ScrcpyPanel(panel, serverUrl, serial);
        ScrcpyPanel.currentPanels.set(serial, scrcpyPanel);
    }

    private constructor(panel: vscode.WebviewPanel, serverUrl: string, serial: string) {
        this.panel = panel;
        this.serverUrl = serverUrl;
        this.serial = serial;

        this.panel.webview.html = this.getWebviewContent();

        this.panel.onDidDispose(() => {
            this.disposed = true;
            this.closeWs();
            ScrcpyPanel.currentPanels.delete(this.serial);
        });

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(msg => {
            switch (msg.type) {
                case 'ready':
                    // Webview JS is loaded and listening — now safe to connect WS
                    this.connectWs();
                    break;
                case 'ws_send':
                    // Webview wants to send binary data to Go server
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        this.ws.send(Buffer.from(msg.data, 'base64'));
                    }
                    break;
                case 'openExternal':
                    vscode.env.openExternal(vscode.Uri.parse(msg.url));
                    break;
            }
        });

        // Do NOT connect WS here — wait for webview 'ready' signal
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
        if (this.disposed) return;
        this.closeWs();

        const proto = this.serverUrl.startsWith('https') ? 'wss' : 'ws';
        const host = this.serverUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const url = `${proto}://${host}/ws/device/${encodeURIComponent(this.serial)}`;

        const ws = new WebSocket(url, { rejectUnauthorized: false });
        this.ws = ws;

        // Connection timeout: force close if stuck in CONNECTING
        this.connectTimeout = setTimeout(() => {
            this.connectTimeout = null;
            if (this.disposed) return;
            if (ws.readyState === WebSocket.CONNECTING) {
                try { ws.terminate(); } catch {}
            }
        }, 8000);

        ws.on('open', () => {
            if (this.connectTimeout) {
                clearTimeout(this.connectTimeout);
                this.connectTimeout = null;
            }
            if (this.disposed) { try { ws.close(); } catch {} return; }
            this.reconnectDelay = 1000;
            this.panel.webview.postMessage({ type: 'ws_open' });
        });

        ws.on('message', (data: Buffer) => {
            if (this.disposed) return;
            // Drop video frames if the webview message queue is backing up
            const ch = data.length > 0 ? data[0] : 0;
            if (ch === 0x01 && this.pendingMessages > 30) return; // 0x01 = video channel
            this.pendingMessages++;
            const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data as ArrayBuffer).toString('base64');
            this.panel.webview.postMessage({ type: 'ws_data', data: b64 }).then(
                () => { this.pendingMessages = Math.max(0, this.pendingMessages - 1); },
                () => { this.pendingMessages = Math.max(0, this.pendingMessages - 1); }
            );
        });

        ws.on('close', () => {
            this.panel.webview.postMessage({ type: 'ws_close' });
            if (!this.disposed) {
                this.reconnectTimer = setTimeout(() => this.connectWs(), this.reconnectDelay);
                this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 10000);
            }
        });

        ws.on('error', () => {});
    }

    private getWebviewContent(): string {
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
        #status-bar {
            display: flex;
            align-items: center;
            padding: 4px 6px;
            background: #252526;
            font-size: 11px;
            gap: 4px;
            flex-shrink: 0;
            flex-wrap: wrap;
        }
        #status-bar .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .dot.green { background: #4ec9b0; }
        .dot.red { background: #f44747; }
        .dot.yellow { background: #dcdcaa; }
        #status-bar button {
            background: #0e639c;
            color: #fff;
            border: none;
            padding: 2px 6px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            white-space: nowrap;
            flex-shrink: 0;
        }
        #status-bar button:hover { background: #1177bb; }
        #status-bar button.nav { background: #333; padding: 2px 4px; }
        #status-bar button.nav:hover { background: #444; }
        .spacer { flex: 1; min-width: 2px; }
        #conn-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80px; }
        #info-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 120px; font-size: 10px; }

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
        video {
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
            color: #ccc;
            font-size: 14px;
            z-index: 10;
        }
        #debug {
            position: absolute;
            top: 4px; right: 4px;
            background: rgba(0,0,0,0.8);
            color: #0f0;
            font-family: 'Consolas', monospace;
            font-size: 10px;
            padding: 4px 8px;
            border-radius: 4px;
            white-space: pre;
            z-index: 20;
        }
    </style>
</head>
<body>
    <div id="status-bar">
        <span class="dot" id="conn-dot"></span>
        <span id="conn-text">Connecting...</span>
        <span class="spacer"></span>
        <button class="nav" id="btn-back">← Back</button>
        <button class="nav" id="btn-home">⊙ Home</button>
        <button class="nav" id="btn-recents">☰ Recents</button>
        <span class="spacer"></span>
        <span id="info-text"></span>
        <button id="btn-control">Request Control</button>
        <button id="btn-audio">🔇</button>
        <button id="btn-debug-toggle">🐛</button>
    </div>
    <div id="canvas-wrapper">
        <div id="overlay">Connecting to device...</div>
        <canvas id="canvas"></canvas>
        <div id="debug" class="hidden"></div>
    </div>

<script>
(function() {
    const vscode = acquireVsCodeApi();

    // ===== Protocol constants =====
    const CH_VIDEO = 0x01, CH_AUDIO = 0x02, CH_CONTROL = 0x03, CH_MGMT = 0x10;
    const PACKET_HEADER = 12;
    const FLAG_CONFIG = BigInt(1) << BigInt(63);
    const FLAG_KEY_FRAME = BigInt(1) << BigInt(62);
    const PTS_MASK = FLAG_KEY_FRAME - BigInt(1);

    // Android key constants
    const AKEY_DOWN = 0, AKEY_UP = 1;
    const AMOTION_DOWN = 0, AMOTION_UP = 1, AMOTION_MOVE = 2;
    const TOUCH_EVENT_MASK = 0xFFFFFFFF >>> 0;

    // Control message types
    const MSG_INJECT_KEYCODE = 0;
    const MSG_INJECT_TOUCH = 2;
    const MSG_INJECT_SCROLL = 3;
    const MSG_BACK_OR_SCREEN_ON = 4;

    // ===== DOM =====
    const canvas = document.getElementById('canvas');
    const overlay = document.getElementById('overlay');
    const connDot = document.getElementById('conn-dot');
    const connText = document.getElementById('conn-text');
    const infoText = document.getElementById('info-text');
    const debugEl = document.getElementById('debug');
    const ctx = canvas.getContext('2d');

    // ===== State =====
    let connected = false;
    let deviceW = 0, deviceH = 0;
    let hasControl = false;

    // Decoder state
    let decoder = null;
    let spsData = null, ppsData = null;
    let codecDesc = '';
    let frameCount = 0;
    let pendingFrames = 0;

    // Stats
    let videoPkts = 0, videoBytes = 0;
    let configPkts = 0, decoderInits = 0, decodeErrors = 0;
    let needKeyFrame = false;
    let msgCount = 0;

    // ===== Base64 helpers =====
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

    // ===== NAL parsing (Annex B → AVCC) =====
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

    // ===== WebCodecs Video Decoder =====
    function initDecoder(codec, w, h) {
        deviceW = w; deviceH = h;
        canvas.width = w; canvas.height = h;
        codecDesc = codec;
        updateSize();

        if (typeof window.VideoDecoder === 'undefined') {
            connText.textContent = 'WebCodecs unavailable';
            return;
        }
    }

    function resetDecoder() {
        if (decoder && decoder.state !== 'closed') {
            try { decoder.close(); } catch {}
        }
        decoder = null;
        pendingFrames = 0;
    }

    // Rebuild decoder from cached SPS/PPS after queue overflow
    function rebuildDecoder() {
        resetDecoder();
        if (!spsData || !ppsData || typeof window.VideoDecoder === 'undefined') return;
        decoderInits++;
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
            error: (e) => {
                decodeErrors++;
                connText.textContent = 'Decoder error: ' + e.message;
            }
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

        videoPkts++;
        videoBytes += packet.length;

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
            configPkts++;
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

        // After rebuild, skip delta frames until a key frame arrives
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

    // ===== Extension host relay (replaces direct WebSocket) =====
    // Receive data from extension host
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
                overlay.textContent = 'Disconnected. Reconnecting...';
                overlay.classList.remove('hidden');
                hasControl = false;
                updateControlBtn();
                break;
            case 'ws_data': {
                msgCount++;
                const data = b64ToU8(msg.data);
                if (data.length < 2) break;
                const ch = data[0];
                const payload = data.slice(1);
                switch (ch) {
                    case CH_VIDEO:
                        feedVideo(payload);
                        break;
                    case CH_AUDIO: break;
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

    // Send binary data to extension host → Go server
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
                infoText.textContent = msg.device_name + ' ' + msg.width + '×' + msg.height;
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

    // ===== Touch input =====
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

    // Scroll event: 21 bytes
    // [0] type=3, [1-4] x, [5-8] y, [9-10] w, [11-12] h, [13-14] hscroll, [15-16] vscroll, [17-20] buttons
    function serializeScroll(x, y, w, h, hscroll, vscroll) {
        const buf = new Uint8Array(21);
        const dv = new DataView(buf.buffer);
        buf[0] = MSG_INJECT_SCROLL;
        dv.setInt32(1, x, false);
        dv.setInt32(5, y, false);
        dv.setUint16(9, w, false);
        dv.setUint16(11, h, false);
        // sc_float_to_i16fp: value * 0x7FFF, clamped
        dv.setInt16(13, Math.round(Math.max(-1, Math.min(1, hscroll)) * 0x7FFF), false);
        dv.setInt16(15, Math.round(Math.max(-1, Math.min(1, vscroll)) * 0x7FFF), false);
        dv.setUint32(17, 0, false); // buttons
        return buf;
    }

    function serializeTouch(action, pointerId, x, y, w, h, pressure) {
        const buf = new Uint8Array(32);
        const dv = new DataView(buf.buffer);
        buf[0] = MSG_INJECT_TOUCH;
        dv.setUint8(1, action);
        // pointer id (8 bytes)
        dv.setUint32(2, 0, false);
        dv.setUint32(6, pointerId & TOUCH_EVENT_MASK, false);
        // position
        dv.setInt32(10, x, false);
        dv.setInt32(14, y, false);
        dv.setUint16(18, w, false);
        dv.setUint16(20, h, false);
        // pressure (uint16)
        dv.setUint16(22, pressure, false);
        // action button + buttons (uint32 each)
        dv.setUint32(24, action === AMOTION_DOWN ? 1 : 0, false);
        dv.setUint32(28, action === AMOTION_UP ? 0 : 1, false);
        return buf;
    }

    function getDevicePos(e) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = deviceW / rect.width;
        const scaleY = deviceH / rect.height;
        return {
            x: Math.round((e.clientX - rect.left) * scaleX),
            y: Math.round((e.clientY - rect.top) * scaleY),
        };
    }

    // Mouse events
    let mouseDown = false;
    canvas.addEventListener('mousedown', (e) => {
        if (!hasControl) return;
        e.preventDefault();
        mouseDown = true;
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
        e.preventDefault();
        mouseDown = false;
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

    // Touch events
    canvas.addEventListener('touchstart', (e) => {
        if (!hasControl) return;
        e.preventDefault();
        for (const t of e.changedTouches) {
            const p = getDevicePos(t);
            sendControl(serializeTouch(AMOTION_DOWN, t.identifier, p.x, p.y, deviceW, deviceH, 0xFFFF));
        }
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        if (!hasControl) return;
        e.preventDefault();
        for (const t of e.changedTouches) {
            const p = getDevicePos(t);
            sendControl(serializeTouch(AMOTION_MOVE, t.identifier, p.x, p.y, deviceW, deviceH, 0xFFFF));
        }
    }, { passive: false });
    canvas.addEventListener('touchend', (e) => {
        if (!hasControl) return;
        e.preventDefault();
        for (const t of e.changedTouches) {
            const p = getDevicePos(t);
            sendControl(serializeTouch(AMOTION_UP, t.identifier, p.x, p.y, deviceW, deviceH, 0));
        }
    }, { passive: false });

    // Scroll wheel → inject scroll event
    canvas.addEventListener('wheel', (e) => {
        if (!hasControl) return;
        e.preventDefault();
        const p = getDevicePos(e);
        // deltaY: negative = scroll up, positive = scroll down
        // scrcpy expects vscroll: positive = up, negative = down (opposite of web)
        const vscroll = -Math.sign(e.deltaY);
        const hscroll = -Math.sign(e.deltaX);
        sendControl(serializeScroll(p.x, p.y, deviceW, deviceH, hscroll, vscroll));
    }, { passive: false });

    // Prevent context menu
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // ===== Resize =====
    function updateSize() {
        if (!deviceW || !deviceH) return;
        const wrapper = document.getElementById('canvas-wrapper');
        const rect = wrapper.getBoundingClientRect();
        const aspect = deviceW / deviceH;
        let w, h;
        if (rect.width / rect.height > aspect) {
            h = rect.height; w = h * aspect;
        } else {
            w = rect.width; h = w / aspect;
        }
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
    }
    window.addEventListener('resize', updateSize);

    // ===== Buttons =====
    function updateControlBtn() {
        const btn = document.getElementById('btn-control');
        btn.textContent = hasControl ? 'Release Control' : 'Request Control';
    }

    document.getElementById('btn-control').addEventListener('click', () => {
        if (hasControl) {
            sendMgmt({ type: 'release_control' });
            hasControl = false;
        } else {
            sendMgmt({ type: 'request_control' });
        }
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

    document.getElementById('btn-audio').addEventListener('click', () => {
        // Audio not implemented in extension
    });

    // Debug toggle
    let debugVisible = false;
    document.getElementById('btn-debug-toggle').addEventListener('click', () => {
        debugVisible = !debugVisible;
        debugEl.classList.toggle('hidden', !debugVisible);
    });
    setInterval(() => {
        if (!debugVisible) return;
        const queueSize = decoder ? decoder.decodeQueueSize : 0;
        debugEl.textContent =
            'Video pkts: ' + videoPkts + '\\n' +
            'Frames: ' + frameCount + '\\n' +
            'Queue: ' + queueSize + '\\n' +
            'Bytes: ' + (videoBytes / 1024 / 1024).toFixed(1) + ' MB\\n' +
            'Codec: ' + codecDesc + '\\n' +
            'Res: ' + deviceW + '×' + deviceH;
    }, 500);

    // No connect() call needed — extension host manages the WebSocket
    // Signal to extension host that webview is ready to receive data
    vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
    }
}
