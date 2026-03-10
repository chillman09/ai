const http = require("http");
const https = require("https");
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENROUTER_API_KEY;

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.url === "/" && req.method === "GET") {
    res.writeHead(200);
    res.end("running - key: " + (API_KEY ? API_KEY.slice(0,10)+"..." : "MISSING"));
    return;
  }

  if (req.url === "/generate" && req.method === "POST") {
    try {
      const body = await getBody(req);

      const payload = JSON.stringify({
       model: "deepseek/deepseek-v3:free",
        messages: [
          {
            role: "system",
           content: "You are a friendly Roblox Studio AI assistant. If the user asks you to create, make, write, or code something, respond with ONLY raw Luau code, no markdown, no backticks. If the user is just chatting, asking a question, or not requesting code, respond normally in plain text like a helpful assistant would."
          },
          {
            role: "user",
            content: body.prompt
          }
        ]
      });

      const options = {
        hostname: "openrouter.ai",
        path: "/api/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + API_KEY,
          "HTTP-Referer": "https://roblox-ai-plugin.com",
          "X-Title": "Roblox AI Plugin",
          "Content-Length": Buffer.byteLength(payload)
        }
      };

      let raw = "";
      const apiReq = https.request(options, (apiRes) => {
        apiRes.on("data", (c) => raw += c);
        apiRes.on("end", () => {
          console.log("OpenRouter response:", raw);
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              console.error("API error:", parsed.error.message);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ code: "-- API error: " + parsed.error.message }));
              return;
            }
            const code = parsed.choices
              && parsed.choices[0]
              && parsed.choices[0].message
              && parsed.choices[0].message.content;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ code: code || "-- No response from AI" }));
          } catch(e) {
            res.writeHead(500);
            res.end(JSON.stringify({ code: "-- parse error: " + raw }));
          }
        });
      });

      apiReq.on("error", (e) => {
        res.writeHead(500);
        res.end(JSON.stringify({ code: "-- connection error: " + e.message }));
      });
      apiReq.write(payload);
      apiReq.end();

    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ code: "-- server error: " + e.message }));
    }
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log("Backend running on port " + PORT));
