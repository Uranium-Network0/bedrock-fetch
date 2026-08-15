const express = require('express');
const cors = require('cors'); // Add this

const app = express();
app.use(cors()); // Add this (allows any website to read your API)
app.use(express.json());

// In-memory array to store recent kills (use a real database like MongoDB/PostgreSQL for production)
let killFeed = [];

// 1. Endpoint for your Minecraft server to POST kills to
app.post('/api/kill', (req, res) => {
  const { killer, victim } = req.body;
  
  if (!killer || !victim) {
    return res.status(400).json({ error: 'Missing killer or victim' });
  }

  const killEvent = { killer, victim, timestamp: new Date() };
  killFeed.unshift(killEvent); // Add to the top of the list

  console.log(`[KILL] ${killer} killed ${victim}`);
  res.status(200).json({ success: true, message: 'Kill recorded!' });
});

// 2. Endpoint for your website frontend to fetch the kill leaderboard/feed
app.get('/api/kills', (req, res) => {
  res.json(killFeed);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
