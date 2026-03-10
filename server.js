// AI Assistant Plugin - Backend Server
// Receives prompts from Roblox Studio and returns Luau code via Anthropic API

const http = require("http");
const https = require("https");

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "YOUR_API_KEY_HERE";

// Helper: parse request body
function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Helper: call Anthropic API
function callAnthropic(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      system:
        "You are a Roblox Luau coding assistant. Always respond with ONLY valid Luau code. No markdown, no backticks, no explanations. Just raw Luau code that can be pasted directly into a Roblox Script.",
    });

    const options = {
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed.content?.[0]?.text || "-- No response";
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// Main server
const server = http.createServer(async (req, res) => {
  // CORS headers so Roblox HttpService can reach us
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "POST" && req.url === "/generate") {
    try {
      const body = await getBody(req);
      const prompt = body.prompt;

      if (!prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing prompt" }));
        return;
      }

      console.log("Prompt received:", prompt.slice(0, 80) + "...");
      const code = await callAnthropic(prompt);
      console.log("Code generated:", code.slice(0, 80) + "...");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code }));
    } catch (err) {
      console.error("Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Health check
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("AI Assistant Plugin Backend is running!");
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log("AI Assistant backend running on port " + PORT);
});
