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
    res.end("AI Plugin running - key: " + (API_KEY ? API_KEY.slice(0,10)+"..." : "MISSING"));
    return;
  }

  if (req.url === "/generate" && req.method === "POST") {
    try {
      const body = await getBody(req);

      // Support both old single-prompt format and new messages format
      let messages = body.messages;
      if (!messages) {
        if (!body.prompt) {
          res.writeHead(400);
          res.end(JSON.stringify({ code: "-- error: missing prompt or messages" }));
          return;
        }
        messages = [
          { role: "system", content: body.system || "You are a helpful Roblox Luau assistant." },
          { role: "user", content: body.prompt }
        ];
      }

      const payload = JSON.stringify({
        model: "glm-5:cloud",
        messages: messages,
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
          console.log("Status:", apiRes.statusCode);
          console.log("Response:", raw.slice(0, 300));
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
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
            res.writeHead(500);
            res.end(JSON.stringify({ code: "-- parse error: " + raw.slice(0, 150) }));
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

server.listen(PORT, () => console.log("AI Plugin backend running on port " + PORT));
