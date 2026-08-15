const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

const PANEL_URL = process.env.PEBBLE_PANEL_URL; // e.g., https://panel.pebblehost.com
const API_KEY = process.env.PEBBLE_API_KEY;     // Client API Key from PebbleHost
const SERVER_ID = process.env.SERVER_ID;         // Short server ID from your panel URL
const WORKER_URL = process.env.WORKER_URL;       // Your Cloudflare Worker endpoint
const SECRET_TOKEN = process.env.SECRET_TOKEN;   // Your shared security token

app.get('/', (req, res) => {
    res.send('PebbleHost Kill Streamer is active!');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    connectToPebbleConsole();
});

async function connectToPebbleConsole() {
    try {
        // Fetch WebSocket authorization details from PebbleHost panel API
        const response = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/websocket`, {
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Accept": "application/json"
            }
        });
        
        const data = await response.json();
        const wsUrl = data.data.url;
        const token = data.data.token;

        const ws = new WebSocket(wsUrl, {
            headers: { "Origin": PANEL_URL }
        });

        ws.on('open', () => {
            console.log('Connected to PebbleHost console stream!');
            ws.send(JSON.stringify({ event: 'auth', args: [token] }));
        });

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                if (message.event === 'console output') {
                    parseLogLine(message.args[0]);
                }
            } catch (err) {
                // Ignore non-json frames
            }
        });

        ws.on('close', () => {
            console.log('Console connection closed. Reconnecting in 5 seconds...');
            setTimeout(connectToPebbleConsole, 5000);
        });

        ws.on('error', (err) => {
            console.error('WebSocket error:', err);
            ws.close();
        });

    } catch (error) {
        console.error('Failed to authorize console stream:', error);
        setTimeout(connectToPebbleConsole, 10000);
    }
}

function parseLogLine(line) {
    // Look for Bedrock death patterns in console output
    if (line.includes("was slain by") || line.includes("was shot by") || line.includes("died")) {
        console.log(`Death log captured: ${line}`);
        
        const parts = line.trim().split(" ");
        const victim = parts[0];
        let killer = "Environment";
        let weapon = "Unknown";

        if (line.includes("was slain by") || line.includes("was shot by")) {
            killer = parts[parts.length - 1];
            weapon = line.includes("was shot by") ? "Projectile" : "Melee";
        }

        sendKillToWorker({ killer, victim, weapon });
    }
}

async function sendKillToWorker(killData) {
    try {
        await fetch(WORKER_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${SECRET_TOKEN}`
            },
            body: JSON.stringify(killData)
        });
    } catch (err) {
        console.error("Failed to forward kill to Cloudflare Worker:", err);
    }
}
