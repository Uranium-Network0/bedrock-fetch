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

// Discord webhook URL - set this in Render's environment variables
// (Discord channel -> Edit Channel -> Integrations -> Webhooks -> New Webhook -> Copy URL)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Escapes Discord markdown/mentions so player names/messages can't break formatting
// or ping @everyone/@here/roles.
function sanitizeForDiscord(text) {
  return String(text)
    .replace(/@(everyone|here)/g, '@\u200b$1')
    .replace(/<@&?!?(\d+)>/g, '<@\u200b$1>')
    .replace(/([_*~`|>])/g, '\\$1');
}

// Sends a message to the configured Discord webhook. Safe to call even if
// the webhook isn't configured yet - it'll just log a warning and skip.
async function sendToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('[WARNING] DISCORD_WEBHOOK_URL is not set, skipping Discord message.');
    return;
  }

  try {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.log(`[Discord Error] ${response.status} ${response.statusText}: ${errBody}`);
    }
  } catch (err) {
    console.error('[Discord Fetch Error]', err.message);
  }
}

// 1. Existing Endpoints
app.post('/api/kill', (req, res) => {
  const { killer, victim, weapon } = req.body;
  if (!killer || !victim) return res.status(400).json({ error: 'Missing data' });

  const killEvent = { killer, victim, weapon: weapon || 'Unknown', timestamp: new Date() };
  killFeed.unshift(killEvent);
  
  // Keep only the last 50 kills to prevent memory issues
  if (killFeed.length > 50) killFeed.pop(); 
  
  console.log(`[POST KILL] ${killer} killed ${victim}`);
  sendToDiscord(`☠️ **${sanitizeForDiscord(killer)}** killed **${sanitizeForDiscord(victim)}**${weapon ? ` with *${sanitizeForDiscord(weapon)}*` : ''}`);
  res.status(200).json({ success: true, message: 'Kill recorded!' });
});

app.get('/api/kills', (req, res) => {
  res.json(killFeed);
});

// New Endpoints - for addons/behavior packs that push events directly via HTTP.
// Bedrock Dedicated Server does NOT write chat to its log file, so /api/chat is
// the reliable way to relay in-game chat (e.g. a script using the chatSend event).
// /api/join and /api/leave are also scraped from the log below, but are provided
// here too in case you'd rather have an addon report them directly.
app.post('/api/join', (req, res) => {
  const { player } = req.body;
  if (!player) return res.status(400).json({ error: 'Missing player' });

  console.log(`[POST JOIN] ${player} joined`);
  sendToDiscord(`🟢 **${sanitizeForDiscord(player)}** joined the game`);
  res.status(200).json({ success: true });
});

app.post('/api/leave', (req, res) => {
  const { player } = req.body;
  if (!player) return res.status(400).json({ error: 'Missing player' });

  console.log(`[POST LEAVE] ${player} left`);
  sendToDiscord(`🔴 **${sanitizeForDiscord(player)}** left the game`);
  res.status(200).json({ success: true });
});

app.post('/api/chat', (req, res) => {
  const { player, message } = req.body;
  if (!player || !message) return res.status(400).json({ error: 'Missing player or message' });

  console.log(`[POST CHAT] ${player}: ${message}`);
  sendToDiscord(`💬 **${sanitizeForDiscord(player)}**: ${sanitizeForDiscord(message)}`);
  res.status(200).json({ success: true });
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

// 3. The Log Line Parser (kills, joins, leaves)
function parseKills(logText) {
  const lines = logText.split('\n');
  
  // Regex to catch standard Minecraft death messages
  const killRegex = /(.+?) (was slain by|was shot by|was killed by|was pummeled by|was burned to death by) (.+)/;

  // Regex to catch BDS connect/disconnect lines, e.g.:
  // [INFO] Player connected: Steve, xuid: 2535413417894718
  // [INFO] Player disconnected: Steve, xuid: 2535413417894718
  const joinRegex = /Player connected: (.+?), xuid: \d+/;
  const leaveRegex = /Player disconnected: (.+?), xuid: \d+/;

  lines.forEach(line => {
    const joinMatch = line.match(joinRegex);
    if (joinMatch) {
      const player = joinMatch[1].trim();
      console.log(`[SCRAPED JOIN] ${player} connected`);
      sendToDiscord(`🟢 **${sanitizeForDiscord(player)}** joined the game`);
      return;
    }

    const leaveMatch = line.match(leaveRegex);
    if (leaveMatch) {
      const player = leaveMatch[1].trim();
      console.log(`[SCRAPED LEAVE] ${player} disconnected`);
      sendToDiscord(`🔴 **${sanitizeForDiscord(player)}** left the game`);
      return;
    }

    const match = line.match(killRegex);
    if (match) {
      // Clean up the victim string to remove the "[INFO]" or timestamp prefix
      const rawVictim = match[1].trim();
      const victim = rawVictim.split(' ').pop(); // Grabs just the player name
      const killer = match[3].trim();
      // We removed 'weapon = match[2]' so it won't store or display the filler text

      console.log(`[SCRAPED KILL] ${killer} killed ${victim}`);
      
      killFeed.unshift({ 
        killer: killer, 
        victim: victim, 
        timestamp: new Date() 
      });

      if (killFeed.length > 50) killFeed.pop();

      sendToDiscord(`☠️ **${sanitizeForDiscord(killer)}** killed **${sanitizeForDiscord(victim)}**`);
    }
  });
}

// Start polling every 10 seconds
setInterval(fetchPebbleHostLogs, 10000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
