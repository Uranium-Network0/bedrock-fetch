const express = require('express');
const cors = require('cors');
const { Client, GatewayIntentBits } = require('discord.js');

const app = express();
app.use(cors());
app.use(express.json());

let killFeed = [];
let lastLogSize = 0;
let hasPolledOnce = false;

const API_KEY = process.env.PEBBLEHOST_API_KEY;
const SERVER_ID = process.env.SERVER_ID;
const PANEL_URL = process.env.PANEL_URL || 'https://panel.pebblehost.com';

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DISCORD_LOGS_WEBHOOK_URL = process.env.WEBHOOK;

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;

function sanitizeForDiscord(text) {
  return String(text)
    .replace(/@(everyone|here)/g, '@\u200b$1')
    .replace(/<@&?!?(\d+)>/g, '<@\u200b$1>')
    .replace(/([_*~`|>])/g, '\\$1');
}

const discordQueues = new Map();

function sendToDiscord(content, webhookUrl = DISCORD_WEBHOOK_URL) {
  if (!webhookUrl) {
    console.log('[WARNING] No Discord webhook URL configured for this message, skipping.');
    return;
  }
  if (!discordQueues.has(webhookUrl)) {
    discordQueues.set(webhookUrl, { queue: [], processing: false });
  }
  discordQueues.get(webhookUrl).queue.push(content);
  processDiscordQueue(webhookUrl);
}

function sendToDiscordLogs(content) {
  sendToDiscord(content, DISCORD_LOGS_WEBHOOK_URL || DISCORD_WEBHOOK_URL);
}

async function processDiscordQueue(webhookUrl) {
  const state = discordQueues.get(webhookUrl);
  if (!state || state.processing) return;
  state.processing = true;

  while (state.queue.length > 0) {
    const content = state.queue.shift();

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });

      if (response.status === 429) {
        const body = await response.json().catch(() => ({}));
        const retryAfterMs = Math.ceil((body.retry_after || 1) * 1000);
        console.log(`[Discord Rate Limited] Waiting ${retryAfterMs}ms before retrying.`);
        state.queue.unshift(content);
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

    await new Promise((r) => setTimeout(r, 500));
  }

  state.processing = false;
}

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

function sanitizeForMinecraft(text) {
  return String(text)
    .replace(/§/g, '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 200);
}

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
    if (message.author.bot) return;
    if (!message.content) return;

    const author = sanitizeForMinecraft(
      message.member?.displayName || message.author.globalName || message.author.username
    );
    const content = sanitizeForMinecraft(message.content);

    console.log(`[DISCORD -> MC] ${author}: ${content}`);

    const rawtext = {
      rawtext: [
        { text: '§9§l[Discord]§r ' },
        { text: `§b${author}` },
        { text: '§7: ' },
        { text: `§f${content}` }
      ]
    };
    sendCommandToServer(`tellraw @a ${JSON.stringify(rawtext)}`);
  });

  discordBot.login(DISCORD_BOT_TOKEN).catch((err) => {
    console.error('[Discord Bot] Failed to log in:', err.message);
  });
} else {
  console.log('[WARNING] DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not set, Discord -> Minecraft relay disabled.');
}

app.post('/api/kill', (req, res) => {
  const { killer, victim, weapon } = req.body;
  if (!killer || !victim) return res.status(400).json({ error: 'Missing data' });

  const killEvent = { killer, victim, weapon: weapon || 'Unknown', timestamp: new Date() };
  killFeed.unshift(killEvent);

  if (killFeed.length > 50) killFeed.pop();

  console.log(`[POST KILL] ${killer} killed ${victim}`);
  sendToDiscord(`☠️ **${sanitizeForDiscord(killer)}** killed **${sanitizeForDiscord(victim)}**${weapon ? ` with *${sanitizeForDiscord(weapon)}*` : ''}`);
  res.status(200).json({ success: true, message: 'Kill recorded!' });
});

app.get('/api/kills', (req, res) => {
  res.json(killFeed);
});

app.post('/api/inventory', (req, res) => {
  const { player, gameMode, slot, before, after } = req.body;
  if (!player) return res.status(400).json({ error: 'Missing player' });

  console.log(`[POST INVENTORY] ${player} (${gameMode || 'unknown'}) slot ${slot}: ${before || 'empty'} -> ${after || 'empty'}`);

  const beforeText = before ? `${before}` : '*empty*';
  const afterText = after ? `${after}` : '*empty*';
  sendToDiscordLogs(`🎒 **${sanitizeForDiscord(player)}**${gameMode ? ` (${sanitizeForDiscord(gameMode)})` : ''} slot ${slot}: ${sanitizeForDiscord(beforeText)} → ${sanitizeForDiscord(afterText)}`);

  res.status(200).json({ success: true });
});

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

async function fetchPebbleHostLogs() {
  if (!API_KEY || !SERVER_ID) {
    console.log("[WARNING] Missing PebbleHost API keys in Render environment variables.");
    return;
  }

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

    if (!hasPolledOnce) {
      hasPolledOnce = true;
      lastLogSize = text.length;
      console.log(`[STARTUP] Skipping replay of existing log (${text.length} chars). Only new lines from here on will be relayed.`);
      return;
    }

    if (text.length < lastLogSize) {
      console.log('[INFO] Log file appears to have been truncated (server restart?). Resetting position.');
      lastLogSize = 0;
    }

    const newText = text.slice(lastLogSize);

    console.log(`[POLL] Success! Log Size: ${text.length} chars | New Data: ${newText.length} chars`);

    lastLogSize = text.length;

    if (newText.length > 0) {
      console.log(`[NEW LOG DATA]:\n${newText.trim()}`);
      parseKills(newText);
    }
  } catch (err) {
    console.error("[Fetch Error] Couldn't connect to PebbleHost:", err.message);
  }
}

function parseKills(logText) {
  const lines = logText.split('\n');

  const killRegex = /(.+?) (was slain by|was shot by|was killed by|was pummeled by|was burned to death by) (.+)/;
  const joinRegex = /Player connected: (.+?), xuid: \d+/;
  const leaveRegex = /Player disconnected: (.+?), xuid: \d+/;
  const chatRegex = /\[CHAT_LOG\] (.+?): (.+)/;
  const invRegex = /\[INV_LOG\] (.+?) \| slot (\d+) \| (.+?) -> (.+)/;

  lines.forEach(line => {
    const invMatch = line.match(invRegex);
    if (invMatch) {
      const player = invMatch[1].trim();
      const slot = invMatch[2].trim();
      const before = invMatch[3].trim();
      const after = invMatch[4].trim();
      console.log(`[SCRAPED INVENTORY] ${player} slot ${slot}: ${before} -> ${after}`);
      sendToDiscordLogs(`🎒 **${sanitizeForDiscord(player)}** (Creative) slot ${slot}: ${sanitizeForDiscord(before)} → ${sanitizeForDiscord(after)}`);
      return;
    }

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
      const rawVictim = match[1].trim();
      const victim = rawVictim.split(' ').pop();
      const killer = match[3].trim();

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

setInterval(fetchPebbleHostLogs, 10000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
