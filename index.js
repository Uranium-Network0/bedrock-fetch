const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let killFeed = [];
let lastLogSize = 0; // Keeps track of where we left off in the log file

// PebbleHost / Pterodactyl Panel Settings
// We will set these in Render so your keys stay safe
const API_KEY = process.env.PEBBLEHOST_API_KEY;
const SERVER_ID = process.env.SERVER_ID; 
const PANEL_URL = process.env.PANEL_URL || 'https://panel.pebblehost.com';

// 1. Existing Endpoints
app.post('/api/kill', (req, res) => {
  const { killer, victim, weapon } = req.body;
  if (!killer || !victim) return res.status(400).json({ error: 'Missing data' });

  const killEvent = { killer, victim, weapon: weapon || 'Unknown', timestamp: new Date() };
  killFeed.unshift(killEvent);
  
  // Keep only the last 50 kills to prevent memory issues
  if (killFeed.length > 50) killFeed.pop(); 
  
  console.log(`[POST KILL] ${killer} killed ${victim}`);
  res.status(200).json({ success: true, message: 'Kill recorded!' });
});

app.get('/api/kills', (req, res) => {
  res.json(killFeed);
});

// 2. The Log Scraper
// 2. The Log Scraper (DEBUG MODE)
async function fetchPebbleHostLogs() {
  if (!API_KEY || !SERVER_ID) {
    console.log("[WARNING] Missing PebbleHost API keys in Render environment variables.");
    return;
  }

  // NOTE: If your log file is named something else, change 'logs/latest.log' below!
  const filePath = 'logs/latest.log'; 
  const url = `${PANEL_URL}/api/client/servers/${SERVER_ID}/files/contents?file=${encodeURIComponent(filePath)}`;

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'text/plain'
      }
    });

    if (!response.ok) {
      console.log(`[API Error] PebbleHost rejected our request.`);
      console.log(`Status: ${response.status} ${response.statusText}`);
      const errBody = await response.text();
      console.log(`Response Body: ${errBody}`);
      return;
    }

    const text = await response.text();
    const newText = text.slice(lastLogSize);
    
    console.log(`[POLL] Success! Log Size: ${text.length} chars | New Data: ${newText.length} chars`);
    
    lastLogSize = text.length; 

    if (newText.length > 0) {
      // Print the new text so we can see the exact format Bedrock is spitting out
      console.log(`[NEW LOG DATA]:\n${newText.trim()}`);
      parseKills(newText);
    }
  } catch (err) {
    console.error("[Fetch Error] Couldn't connect to PebbleHost:", err.message);
  }
}

function parseKills(logText) {
  const lines = logText.split('\n');
  
  // New regex looking for our custom Bedrock script output
  const killRegex = /\[KILL_LOG\] (.*?) was killed by (.*)/;

  lines.forEach(line => {
    const match = line.match(killRegex);
    if (match) {
      const victim = match[1].trim();
      const killer = match[2].trim();
      
      console.log(`🗡️ KILL DETECTED: ${killer} killed ${victim}`);
      sendToCloudflare(killer, victim);
    }
  });
}

// Start polling every 10 seconds
setInterval(fetchPebbleHostLogs, 10000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
