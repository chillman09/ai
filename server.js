const http = require("http");
const https = require("https");
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OLLAMA_API_KEY;

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
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("AI Plugin running - Ollama key: " + (API_KEY ? API_KEY.slice(0,10)+"..." : "MISSING"));
    return;
  }

  if (req.url === "/generate" && req.method === "POST") {
    try {
      const body = await getBody(req);
      if (!body.prompt) {
        res.writeHead(400);
        res.end(JSON.stringify({ code: "-- error: missing prompt" }));
        return;
      }

      const payload = JSON.stringify({
        model: "glm-5:cloud",
        messages: [
          {
            role: "system",
            content: "You are a Roblox Luau coding expert built into Roblox Studio. When asked to write or edit code, respond with ONLY raw working Luau code — no markdown, no backticks, no explanations. When the user is just chatting (not asking for code), reply in plain conversational text, 1-2 sentences max."
          },
          {
            role: "user",
            content: body.prompt
          }
        ],
        stream: false
      });

      const options = {
        hostname: "ollama.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + API_KEY,
          "Content-Length": Buffer.byteLength(payload)
        }
      };

      let raw = "";
      const apiReq = https.request(options, (apiRes) => {
        apiRes.on("data", (c) => raw += c);
        apiRes.on("end", () => {
          console.log("Ollama status:", apiRes.statusCode);
          console.log("Ollama response:", raw.slice(0, 300));
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              console.error("Ollama error:", parsed.error);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ code: "-- API error: " + (parsed.error.message || JSON.stringify(parsed.error)) }));
              return;
            }
            const text = parsed.choices
              && parsed.choices[0]
              && parsed.choices[0].message
              && parsed.choices[0].message.content;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ code: text || "-- No response from AI" }));
          } catch(e) {
            console.error("Parse error:", e.message, "Raw:", raw.slice(0, 200));
            res.writeHead(500);
            res.end(JSON.stringify({ code: "-- parse error: " + raw.slice(0, 100) }));
          }
        });
      });

      apiReq.on("error", (e) => {
        console.error("Request error:", e.message);
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

server.listen(PORT, () => console.log("AI Plugin backend running on port " + PORT));
