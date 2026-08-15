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
        // Updated path to target logs/latest.log accurately
        const response = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/files/contents?file=logs%2Flatest.log`, {
            headers: {
                "Authorization": `Bearer ${API_KEY}`,
                "Accept": "application/json"
            }
        });

        if (!response.ok) {
            console.error(`Failed to fetch log file: ${response.status} ${response.statusText}`);
            return;
        }

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
        console.error("Polling error:", err.message);
    }
}

function parseLogLine(line) {
    console.log("LOG: " + line);

    // Bedrock death line filters
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
}
