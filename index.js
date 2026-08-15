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
async function fetchPebbleHostLogs() {
  if (!API_KEY || !SERVER_ID) {
    console.log("[WARNING] Missing PebbleHost API keys in Render environment variables.");
    return;
  }

  try {
    const response = await fetch(`${PANEL_URL}/api/client/servers/${SERVER_ID}/files/contents?file=logs/latest.log`, {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Accept': 'text/plain'
      }
    });

    if (!response.ok) {
      console.log(`[API Error] Failed to read log: ${response.statusText}`);
      return;
    }

    const text = await response.text();
    
    // Only parse new text since the last check
    const newText = text.slice(lastLogSize);
    lastLogSize = text.length; 

    if (newText.length > 0) {
      parseKills(newText);
    }
  } catch (err) {
    console.error("[Fetch Error] Couldn't connect to PebbleHost:", err.message);
  }
}

// 3. The Death Message Parser
function parseKills(logText) {
  const lines = logText.split('\n');
  
  // Regex to catch standard Minecraft death messages
  // Example: "[INFO] Player1 was slain by Player2"
  const killRegex = /(.+?) (was slain by|was shot by|was killed by|was pummeled by|was burned to death by) (.+)/;

  lines.forEach(line => {
    const match = line.match(killRegex);
    if (match) {
      // Clean up the victim string to remove the "[INFO]" or timestamp prefix
      const rawVictim = match[1].trim();
      const victim = rawVictim.split(' ').pop(); // Grabs just the player name
      const killer = match[3].trim();
      const weapon = match[2]; // e.g., "was slain by"

      console.log(`[SCRAPED KILL] ${killer} killed ${victim}`);
      
      killFeed.unshift({ 
        killer: killer, 
        victim: victim, 
        weapon: weapon,
        timestamp: new Date() 
      });
    }
  });
}

// Start polling every 10 seconds
setInterval(fetchPebbleHostLogs, 10000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
