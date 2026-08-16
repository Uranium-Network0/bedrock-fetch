const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

let killFeed = [];
let lastLogSize = 0; // Keeps track of where we left off in the log file
let hasPolledOnce = false; // See fetchPebbleHostLogs - avoids replaying the whole log on restart

// PebbleHost / Pterodactyl Panel Settings
// We will set these in Render so your keys stay safe
const API_KEY = process.env.PEBBLEHOST_API_KEY;
const SERVER_ID = process.env.SERVER_ID; 
const PANEL_URL = process.env.PANEL_URL || 'https://panel.pebblehost.com';

// Discord webhook URL - set this in Render's environment variables
// (Discord channel -> Edit Channel -> Integrations -> Webhooks -> New Webhook -> Copy URL)
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Discord BOT credentials - needed for the Discord -> Minecraft direction,
// since webhooks are send-only and can't listen for messages.
// DISCORD_BOT_TOKEN comes from the Discord Developer Portal.
// DISCORD_CHANNEL_ID is the channel the bot listens in (right-click the
// channel in Discord with Developer Mode on -> Copy Channel ID).
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

// Escapes Discord markdown/mentions so player names/messages can't break formatting
// or ping @everyone/@here/roles.
function sanitizeForDiscord(text) {
  return String(text)
    .replace(/@(everyone|here)/g, '@\u200b$1')
    .replace(/<@&?!?(\d+)>/g, '<@\u200b$1>')
    .replace(/([_*~`|>])/g, '\\$1');
}

// Sends a message to the configured Discord webhook. Queued and spaced out
// (see below) so a burst of events (e.g. several kills in one poll) can't
// trip Discord's rate limit by firing all at once.
const discordQueue = [];
let isProcessingDiscordQueue = false;

function sendToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    console.log('[WARNING] DISCORD_WEBHOOK_URL is not set, skipping Discord message.');
    return;
  }
  discordQueue.push(content);
  processDiscordQueue();
}

async function processDiscordQueue() {
  if (isProcessingDiscordQueue) return;
  isProcessingDiscordQueue = true;

  while (discordQueue.length > 0) {
    const content = discordQueue.shift();

    try {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });

      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        const retryAfterMs = Math.ceil((body.retry_after || 1) * 1000);
        console.log(`[Discord Rate Limited] Waiting ${retryAfterMs}ms before retrying.`);
        discordQueue.unshift(content); // put it back at the front, retry it
        await new Promise((r) => setTimeout(r, retryAfterMs));
        continue;
      }

      if (!response.ok) {
        const errBody = await response.text();
        console.log(`[Discord Error] ${response.status} ${response.statusText}: ${errBody}`);
      }
    } catch (err) {
      console.error('[Discord Fetch Error]', err.message);
    }

    // Space out sends so we stay well under Discord's per-webhook rate limit.
    await new Promise((r) => setTimeout(r, 500));
  }

  isProcessingDiscordQueue = false;
}

// Sends a console command to the Bedrock server via Pterodactyl's client API.
// Returns silently (with a log line) on failure - most commonly because the
// server is offline, which Pterodactyl reports as an HTTP 412.
async function sendCommandToServer(command) {
  if (!API_KEY || !SERVER_ID) {
    console.log('[WARNING] Missing PebbleHost API keys, cannot send console command.');
    return;
  }

  const url = `${PANEL_URL}/api/client/servers/${SERVER_ID}/command`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ command })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.log(`[Command Error] ${response.status} ${response.statusText}: ${errBody}`);
    }
  } catch (err) {
    console.error('[Command Fetch Error]', err.message);
  }
}

// Strips characters that would otherwise break the Bedrock tellraw JSON or
// abuse formatting codes, and caps message length.
function sanitizeForMinecraft(text) {
  return String(text)
    .replace(/§/g, '')       // strip Minecraft formatting codes
    .replace(/[\r\n]+/g, ' ') // collapse newlines
    .slice(0, 200);
}

// Discord -> Minecraft bridge. Needs Message Content Intent enabled in the
// Developer Portal, and the bot invited to your server with permission to
// read/view the target channel.
let discordBot = null;
if (DISCORD_BOT_TOKEN && DISCORD_CHANNEL_ID) {
  discordBot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  discordBot.once('ready', () => {
    console.log(`[Discord Bot] Logged in as ${discordBot.user.tag}`);
  });

  discordBot.on('messageCreate', (message) => {
    if (message.channelId !== DISCORD_CHANNEL_ID) return;
    if (message.author.bot) return; // ignore our own webhook posts and other bots
    if (!message.content) return; // ignore attachment/embed-only messages

    const author = sanitizeForMinecraft(message.author.username);
    const content = sanitizeForMinecraft(message.content);

    console.log(`[DISCORD -> MC] ${author}: ${content}`);

    const rawtext = { rawtext: [{ text: `§9[Discord] §b${author}: §f${content}` }] };
    sendCommandToServer(`tellraw @a ${JSON.stringify(rawtext)}`);
  });

  discordBot.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error('[Discord Bot] Failed to log in:', err.message);
  });
} else {
  console.log('[WARNING] DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not set, Discord -> Minecraft relay disabled.');
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

    // On the very first poll after a (re)start, don't parse anything - just
    // record the current file size. Otherwise every restart would replay the
    // server's entire log history and flood Discord with duplicate messages.
    if (!hasPolledOnce) {
      hasPolledOnce = true;
      lastLogSize = text.length;
      console.log(`[STARTUP] Skipping replay of existing log (${text.length} chars). Only new lines from here on will be relayed.`);
      return;
    }

    // If the log file is now smaller than our last recorded position, the
    // Bedrock server itself was restarted and logs/latest.log got truncated.
    // Treat everything currently in the file as new rather than getting
    // stuck forever waiting for a position that no longer exists.
    if (text.length < lastLogSize) {
      console.log('[INFO] Log file appears to have been truncated (server restart?). Resetting position.');
      lastLogSize = 0;
    }

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

  // Regex to catch the custom console line written by the ChatLogBP pack, e.g.:
  // [Scripting] [CHAT_LOG] Steve: hello everyone
  const chatRegex = /\[CHAT_LOG\] (.+?): (.+)/;

  lines.forEach(line => {
    const chatMatch = line.match(chatRegex);
    if (chatMatch) {
      const player = chatMatch[1].trim();
      const message = chatMatch[2].trim();
      console.log(`[SCRAPED CHAT] ${player}: ${message}`);
      sendToDiscord(`💬 **${sanitizeForDiscord(player)}**: ${sanitizeForDiscord(message)}`);
      return;
    }

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
