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

function callOllama(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "glm-5:cloud",
      messages,
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
    const req = https.request(options, (res) => {
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          const text = parsed.choices?.[0]?.message?.content;
          if (text) resolve(text);
          else reject(new Error(parsed.error?.message || "No content: " + raw.slice(0,200)));
        } catch(e) { reject(new Error("Parse error: " + raw.slice(0,200))); }
      });
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

const SYSTEM_PROMPT = `You are an AI assistant embedded in Roblox Studio. You control the game directly.

You respond with a JSON object in this EXACT format:
{
  "reply": "A short friendly message to show the user",
  "actions": [
    // list of actions to perform, or empty array [] if just chatting
  ]
}

Available actions:

1. Create a script:
{"type":"create_script","scriptType":"Script|LocalScript|ModuleScript","name":"ScriptName","parent":"game.ServerScriptService","source":"-- lua code here"}

2. Edit an existing script:
{"type":"edit_script","path":"game.ServerScriptService.ScriptName","source":"-- new full source"}

3. Create an instance (part, folder, gui, etc):
{"type":"create_instance","className":"Part","name":"MyPart","parent":"game.Workspace","properties":{"Size":[4,1,4],"BrickColor":"Bright red","Anchored":true}}

4. Delete an instance:
{"type":"delete_instance","path":"game.Workspace.PartName"}

5. Set a property:
{"type":"set_property","path":"game.Workspace.PartName","property":"BrickColor","value":"Bright blue"}

6. Reply only (no actions):
{"type":"chat"}

RULES:
- ALWAYS respond with valid JSON. Nothing outside the JSON object.
- For scripts, write complete working Luau code. No markdown in the source field.
- Script names should be descriptive (CoinSystem, LeaderboardManager) NOT named after the user's prompt.
- When asked to build a game feature, create ALL necessary scripts and instances.
- When editing, rewrite the full script with changes applied.
- Use proper Roblox services: Players, RunService, TweenService, DataStoreService etc.
- Write clean, commented, production-quality code.
- If a task is big, break it into multiple actions in one response.
- For "chat" or questions, just set actions to [] and answer in reply.`;

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
      if (!body.messages && !body.prompt) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "missing messages or prompt" }));
        return;
      }

      // Build messages array
      let messages;
      if (body.messages) {
        // Ensure system prompt is first
        messages = [{ role: "system", content: SYSTEM_PROMPT }, ...body.messages.filter(m => m.role !== "system")];
      } else {
        messages = [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: body.prompt }
        ];
      }

      console.log("Calling AI with", messages.length, "messages");

      let rawResponse = await callOllama(messages);
      console.log("Raw response:", rawResponse.slice(0, 300));

      // Try to extract JSON if model wraps it in markdown
      let jsonStr = rawResponse;
      const jsonMatch = rawResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) jsonStr = jsonMatch[1];
      // Try to find { ... } if still not clean
      const objMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch(e) {
        // AI didn't return valid JSON - wrap it as a chat reply
        console.error("JSON parse failed, wrapping as chat:", e.message);
        parsed = { reply: rawResponse, actions: [] };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed));

    } catch(e) {
      console.error("Server error:", e.message);
      res.writeHead(500);
      res.end(JSON.stringify({ reply: "Server error: " + e.message, actions: [] }));
    }
    return;
  }

  // Plan endpoint - breaks a game idea into steps
  if (req.url === "/plan" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const messages = [
        {
          role: "system",
          content: `You are a Roblox game architect. Given a game idea, respond with a JSON object:
{
  "title": "Game Name",
  "description": "One sentence description",
  "steps": [
    {"id": 1, "title": "Step title", "description": "What to build", "type": "script|world|both"},
    ...
  ]
}
Make 5-8 specific, implementable steps. Each step = one feature/system. No markdown outside JSON.`
        },
        { role: "user", content: "Game idea: " + body.idea + "\n\nExisting game:\n" + (body.context || "Empty game") }
      ];

      let raw = await callOllama(messages);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      let plan;
      try {
        plan = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch(e) {
        plan = { title: "Game Plan", description: body.idea, steps: [] };
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(plan));
    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Execute a single plan step
  if (req.url === "/step" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `You are implementing step ${body.stepId} of a Roblox game.

Full plan:
${body.steps.map((s,i) => `${i+1}. ${s.title}: ${s.description}`).join("\n")}

Current game state:
${body.context}

Previously done steps:
${body.history || "None yet"}

NOW implement step ${body.stepId}: "${body.step.title}" - ${body.step.description}

Write complete, working code. Create all necessary scripts and instances for this step.`
        }
      ];

      let raw = await callOllama(messages);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      let result;
      try {
        result = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch(e) {
        result = { reply: raw, actions: [] };
      }

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
