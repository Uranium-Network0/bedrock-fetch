const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const PANEL_URL = process.env.PEBBLE_PANEL_URL; 
const API_KEY = process.env.PEBBLE_API_KEY;     
const SERVER_ID = process.env.SERVER_ID;         
const WORKER_URL = process.env.WORKER_URL;       
const SECRET_TOKEN = process.env.SECRET_TOKEN;   

let lastProcessedLineCount = 0;

app.get('/', (req, res) => {
    res.send('PebbleHost Log Streamer is active!');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    setInterval(pollServerLog, 3000);
});

async function pollServerLog() {
    try {
        const response = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/files/contents?file=server.log`, {
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Accept": "application/json"
            }
        });

        if (!response.ok) return;

        const logText = await response.text();
        const lines = logText.split('\n');

        if (lines.length > lastProcessedLineCount) {
            const newLines = lines.slice(lastProcessedLineCount);
            lastProcessedLineCount = lines.length;

            for (const line of newLines) {
                if (line.trim()) {
                    parseLogLine(line);
                }
            }
        }
    } catch (err) {
        // Silently retry on network blips
    }
}

function parseLogLine(line) {
    console.log("LOG: " + line);

    if (line.includes("slain") || line.includes("shot") || line.includes("died") || line.includes("by")) {
        console.log(`Death detected in logs: ${line}`);
        
        const parts = line.trim().split(" ");
        const victim = parts[0];
        let killer = "Environment";
        let weapon = "Unknown";

        if (line.includes("slain by") || line.includes("shot by")) {
            killer = parts[parts.length - 1];
            weapon = line.includes("shot by") ? "Projectile" : "Melee";
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
        console.log("Successfully sent kill to Cloudflare Worker!");
    } catch (err) {
        console.error("Failed to forward kill:", err.message);
    }
}const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

const PANEL_URL = process.env.PEBBLE_PANEL_URL; 
const API_KEY = process.env.PEBBLE_API_KEY;     
const SERVER_ID = process.env.SERVER_ID;         
const WORKER_URL = process.env.WORKER_URL;       
const SECRET_TOKEN = process.env.SECRET_TOKEN;   

let lastProcessedLineCount = 0;

app.get('/', (req, res) => {
    res.send('PebbleHost Log Streamer is active!');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    // Poll the server log file every 3 seconds
    setInterval(pollServerLog, 3000);
});

async function pollServerLog() {
    try {
        // Fetch the contents of the server's main log file (usually server.log or latest.log)
        const response = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/files/contents?file=server.log`, {
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Accept": "application/json"
            }
        });

        if (!response.ok) return;

        const logText = await response.text();
        const lines = logText.split('\n');

        // If new lines have appeared since last check
        if (lines.length > lastProcessedLineCount) {
            const newLines = lines.slice(lastProcessedLineCount);
            lastProcessedLineCount = lines.length;

            for (const line of newLines) {
                if (line.trim()) {
                    parseLogLine(line);
                }
            }
        }
    } catch (err) {
        // Silently retry on network blips
    }
}

function parseLogLine(line) {
    console.log("LOG: " + line);

    // Look for Bedrock death messages (e.g. "Player died", "Player slain by Player")
    if (line.includes("slain") || line.includes("shot") || line.includes("died") || line.includes("by")) {
        console.log(`Death detected in logs: ${line}`);
        
        const parts = line.trim().split(" ");
        const victim = parts[0];
        let killer = "Environment";
        let weapon = "Unknown";

        if (line.includes("slain by") || line.includes("shot by")) {
            killer = parts[parts.length - 1];
            weapon = line.includes("shot by") ? "Projectile" : "Melee";
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
        console.log("Successfully sent kill to Cloudflare Worker!");
    } catch (err) {
        console.error("Failed to forward kill:", err.message);
    }
}const express = require('express');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;

const PANEL_URL = process.env.PEBBLE_PANEL_URL; 
const API_KEY = process.env.PEBBLE_API_KEY;     
const SERVER_ID = process.env.SERVER_ID;         
const WORKER_URL = process.env.WORKER_URL;       
const SECRET_TOKEN = process.env.SECRET_TOKEN;   

app.get('/', (req, res) => {
    res.send('PebbleHost Kill Streamer is active!');
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    connectToPebbleConsole();
});

async function connectToPebbleConsole() {
    try {
        const response = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/websocket`, {
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Accept": "application/json"
            }
        });
        
        const result = await response.json();
        
        const wsUrl = result.data.socket; 
        const token = result.data.token;

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
            console.error('WebSocket error:', err.message);
            ws.close();
        });

    } catch (error) {
        console.error('Failed to authorize console stream:', error.message);
        setTimeout(connectToPebbleConsole, 10000);
    }
}

function parseLogLine(line) {
    // Print everything to log so we can see Bedrock chat/deaths
    console.log("CONSOLE: " + line);

    if (line.includes("slain") || line.includes("shot") || line.includes("died") || line.includes("by")) {
        console.log(`Potential death captured: ${line}`);
        
        const parts = line.trim().split(" ");
        const victim = parts[0];
        let killer = "Environment";
        let weapon = "Unknown";

        if (line.includes("slain by") || line.includes("shot by")) {
            killer = parts[parts.length - 1];
            weapon = line.includes("shot by") ? "Projectile" : "Melee";
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
        console.error("Failed to forward kill to Cloudflare Worker:", err.message);
    }
}function parseLogLine(line) {
    // TEMPORARY: Print every single console line so we can see how Bedrock formats deaths
    console.log("CON: " + line);

    // Look for Bedrock death patterns 
    if (line.includes("slain") || line.includes("shot") || line.includes("died") || line.includes("by")) {
        console.log(`Potential death captured: ${line}`);
        
        const parts = line.trim().split(" ");
        const victim = parts[0];
        let killer = "Environment";
        let weapon = "Unknown";

        if (line.includes("slain by") || line.includes("shot by")) {
            killer = parts[parts.length - 1];
            weapon = line.includes("shot by") ? "Projectile" : "Melee";
        }

        sendKillToWorker({ killer, victim, weapon });
    }
}
