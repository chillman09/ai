const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch (e) { reject(e); }
    });
  });
}

function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: "You are a Roblox Luau coding assistant. Always respond with ONLY valid Luau code. No markdown, no backticks, no explanations.",
      messages: [{ role: "user", content: prompt }]
    });

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        console.log("Anthropic raw response:", data);
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message));
            return;
          }
          const text = parsed.content && parsed.content[0] && parsed.content[0].text;
          if (text) resolve(text);
          else reject(new Error("No content in response: " + data));
        } catch (e) { reject(e); }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("AI Plugin Backend running! Key set: " + (ANTHROPIC_API_KEY ? "YES" : "NO - MISSING KEY"));
    return;
  }

  if (req.method === "GET" && req.url === "/debug") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", keySet: !!ANTHROPIC_API_KEY, keyPrefix: ANTHROPIC_API_KEY ? ANTHROPIC_API_KEY.substring(0, 15) + "..." : "MISSING" }));
    return;
  }

  if (req.method === "POST" && req.url === "/generate") {
    try {
      const body = await getBody(req);
      if (!body.prompt) { res.writeHead(400); res.end(JSON.stringify({ error: "Missing prompt" })); return; }
      console.log("Prompt:", body.prompt.substring(0, 100));
      const code = await callAnthropic(body.prompt);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
    } catch (err) {
      console.error("Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => console.log("Backend running on port " + PORT));
```

6. Click **Commit changes**
7. Railway will auto-redeploy in ~1 minute

---

Then run the debug test again in Studio's Command Bar:
```
local s=game.ServerStorage.DebugTest.Source loadstring(s)()
