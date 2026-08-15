addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
})

async function handleRequest(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const data = await request.json();
    const logLine = data.logLine || '';

    // Check if the log line contains "death", "die", or "died" (case-insensitive)
    const regex = /\b(death|die|died)\b/i;
    if (regex.test(logLine)) {
      // Forward the matched log line to your Cloudflare Worker or external endpoint
      // Replace with your target Worker URL or handle processing here
      console.log(`Matched log line: ${logLine}`);
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
