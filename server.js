const http = require("http");
const https = require("https");
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OLLAMA_API_KEY;

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch(e) { reject(e); }
    });
  });
}

function callOllama(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model: "glm-5:cloud", messages, stream: false });
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
    const req = https.request(options, res => {
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          const text = parsed.choices?.[0]?.message?.content;
          if (text) resolve(text);
          else reject(new Error(parsed.error?.message || "No content"));
        } catch(e) { reject(new Error("Parse error: " + raw.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function safeJSON(raw) {
  try {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const s = m ? m[1] : raw;
    const o = s.match(/\{[\s\S]*\}/);
    return JSON.parse(o ? o[0] : s);
  } catch(e) { return null; }
}

// ─── SYSTEM PROMPT for /generate and /step ───────────────────────────────────
const ACTION_SYSTEM = `You are an AI assistant inside Roblox Studio. You control the game directly.

Respond ONLY with a JSON object:
{
  "reply": "Short friendly message to the user",
  "actions": [ ...array of actions or empty [] ]
}

Actions:
{"type":"create_script","scriptType":"Script|LocalScript|ModuleScript","name":"ProperName","parent":"game.ServerScriptService","source":"-- code"}
{"type":"edit_script","path":"game.ServerScriptService.ScriptName","source":"-- full new source"}
{"type":"create_instance","className":"Part","name":"MyPart","parent":"game.Workspace","properties":{"Size":[4,1,4],"Anchored":true,"BrickColor":"Bright red"}}
{"type":"delete_instance","path":"game.Workspace.PartName"}
{"type":"set_property","path":"game.Workspace.Part","property":"BrickColor","value":"Bright blue"}

RULES:
- ALWAYS respond with valid JSON only. Nothing outside the JSON.
- Script names must be descriptive (CoinSystem, LeaderboardManager). NEVER name them after the user's prompt.
- Write complete, working, production-quality Luau code. No markdown inside source fields.
- Use proper Roblox services. Handle edge cases.
- If nothing needs to be done, return actions: [].`;

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

  // ── /generate  – normal chat + code ──────────────────────────────────────
  if (req.url === "/generate" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const msgs = body.messages || [{ role:"user", content: body.prompt || "" }];
      const clean = msgs.filter(m => m.role !== "system");
      const messages = [{ role:"system", content: ACTION_SYSTEM }, ...clean];

      console.log("Calling AI with", messages.length, "messages");
      let raw = await callOllama(messages);
      console.log("Raw:", raw.slice(0, 200));

      let parsed = safeJSON(raw);
      if (!parsed) parsed = { reply: raw, actions: [] };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ reply: "Error: " + e.message, actions: [] }));
    }
    return;
  }

  // ── /scan  – deep game analysis ──────────────────────────────────────────
  if (req.url === "/scan" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const context = body.context || "";

      const messages = [
        {
          role: "system",
          content: `You are an expert Roblox game analyst. The user has given you the full source code and structure of their Roblox game. 
Analyze it thoroughly and respond in this exact format:

## 🗺️ Game Overview
[What type of game this is, what systems are in it, 2-3 sentences]

## 📁 Structure
[List every script and key instance with one-line description of what it does]

## 🐛 Bugs Found
[Number each bug. Explain what it is, why it breaks things, and exactly how to fix it. If no bugs, say "No bugs found!"]

## ⚠️ Missing Systems
[What important systems are missing that this type of game usually needs]

## 💡 Suggestions
[2-3 concrete improvements you'd recommend]

Be specific. Reference actual script names, line numbers if relevant, and instance paths.`
        },
        {
          role: "user",
          content: "Here is my full Roblox game:\n\n" + context
        }
      ];

      console.log("Scanning game...");
      const analysis = await callOllama(messages);
      console.log("Scan done:", analysis.slice(0, 100));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ analysis }));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ analysis: "Error during scan: " + e.message }));
    }
    return;
  }

  // ── /plan  – break game idea into steps ──────────────────────────────────
  if (req.url === "/plan" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const messages = [
        {
          role: "system",
          content: `You are a Roblox game architect. Given a game idea, respond ONLY with JSON:
{
  "title": "Game Name",
  "description": "One sentence",
  "steps": [
    {"id":1,"title":"Step title","description":"What to build exactly","type":"script|world|both"},
    ...
  ]
}
5-8 specific implementable steps. Each step = one feature. No markdown outside JSON.`
        },
        {
          role: "user",
          content: "Game idea: " + body.idea + "\n\nCurrent game:\n" + (body.context || "Empty game")
        }
      ];
      let raw = await callOllama(messages);
      let plan = safeJSON(raw);
      if (!plan) plan = { title: body.idea, description: "", steps: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(plan));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── /step  – execute one plan step ───────────────────────────────────────
  if (req.url === "/step" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const messages = [
        { role: "system", content: ACTION_SYSTEM },
        {
          role: "user",
          content: `Implement step ${body.stepId} of this Roblox game plan.

Full plan:
${body.steps.map((s,i)=>`${i+1}. ${s.title}: ${s.description}`).join("\n")}

Current game state:
${body.context}

Previously completed:
${body.history || "Nothing yet"}

NOW implement step ${body.stepId}: "${body.step.title}" — ${body.step.description}

Create all necessary scripts and instances. Write complete working code.`
        }
      ];
      let raw = await callOllama(messages);
      let result = safeJSON(raw);
      if (!result) result = { reply: raw, actions: [] };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ reply: "Error: " + e.message, actions: [] }));
    }
    return;
  }

  res.writeHead(404); res.end("not found");
});

server.listen(PORT, () => console.log("AI Plugin backend running on port " + PORT));
