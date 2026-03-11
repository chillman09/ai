const http = require("http");
const https = require("https");
const crypto = require("crypto");
const PORT = process.env.PORT || 3000;

const OLLAMA_KEY     = process.env.OLLAMA_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const JWT_SECRET     = process.env.JWT_SECRET || "spark-secret-change-me";
const PLUGIN_TOKEN   = process.env.PLUGIN_TOKEN;

// ── IN-MEMORY STORES ──────────────────────────────────────────────────────────
const users          = {};  // email → user object
const sessions       = {};  // token → session
const actionQueues   = {};  // token → { actions[], queuedAt }
const studioHeartbeat= {};  // token → lastSeen timestamp
const gameContexts   = {};  // token → { context: string, updatedAt: timestamp }

// ── HELPERS ───────────────────────────────────────────────────────────────────
function hash(str) {
  return crypto.createHash("sha256").update(str + JWT_SECRET).digest("hex");
}
function genToken() {
  return "spk_" + crypto.randomBytes(24).toString("hex");
}
function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch(e) { reject(e); }
    });
  });
}
function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(data));
}
function safeJSON(raw) {
  try {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const s = m ? m[1] : raw;
    const o = s.match(/\{[\s\S]*\}/);
    return JSON.parse(o ? o[0] : s);
  } catch(e) { return null; }
}
function getTokenFromReq(body, req) {
  return body?.sessionToken ||
    req.headers["authorization"]?.replace("Bearer ", "") ||
    body?.token || null;
}

// ── AI CALLERS ────────────────────────────────────────────────────────────────
async function callOllama(model, messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages, stream: false });
    const req = https.request({
      hostname: "ollama.com", path: "/v1/chat/completions", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OLLAMA_KEY,
        "Content-Length": Buffer.byteLength(payload)
      }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(raw);
          const t = p.choices?.[0]?.message?.content;
          if (t) resolve(t); else reject(new Error(p.error?.message || "No content: " + raw.slice(0,80)));
        } catch(e) { reject(new Error("Parse error: " + raw.slice(0,80))); }
      });
    });
    req.on("error", reject); req.write(payload); req.end();
  });
}

async function callOpenRouter(model, messages) {
  if (!OPENROUTER_KEY) throw new Error("OPENROUTER_KEY not set in Railway env vars");
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages, stream: false });
    const req = https.request({
      hostname: "openrouter.ai", path: "/api/v1/chat/completions", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + OPENROUTER_KEY,
        "HTTP-Referer": "https://website-six-bay-23.vercel.app",
        "X-Title": "Spark AI",
        "Content-Length": Buffer.byteLength(payload)
      }
    }, res => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const p = JSON.parse(raw);
          const t = p.choices?.[0]?.message?.content;
          if (t) resolve(t); else reject(new Error(p.error?.message || "No content"));
        } catch(e) { reject(new Error("Parse: " + raw.slice(0,80))); }
      });
    });
    req.on("error", reject); req.write(payload); req.end();
  });
}

// ── MODEL REGISTRY ────────────────────────────────────────────────────────────
const MODELS = {
  "glm5":     { tier:"free", call: m => callOllama("glm-5:cloud", m) },
  "llama31":  { tier:"free", call: m => callOllama("llama3.1:8b", m) },
  "gpt4o":    { tier:"paid", call: m => callOpenRouter("openai/gpt-4o", m) },
  "claude35": { tier:"paid", call: m => callOpenRouter("anthropic/claude-3.5-sonnet", m) },
  "grok3":    { tier:"paid", call: m => callOpenRouter("x-ai/grok-3-mini-beta", m) },
  "gemini25": { tier:"paid", call: m => callOpenRouter("google/gemini-2.5-pro-preview", m) },
};

// ── SYSTEM PROMPTS ────────────────────────────────────────────────────────────
const ACTION_SYSTEM = `You are Spark, an AI assistant that controls Roblox Studio directly.
You have full knowledge of the user's game — its scripts, workspace, and structure — provided below.

Respond ONLY with a JSON object:
{
  "reply": "Short friendly message explaining what you did or found",
  "actions": []
}

Available actions:
{"type":"create_script","scriptType":"Script|LocalScript|ModuleScript","name":"ProperName","parent":"game.ServerScriptService","source":"-- full luau code"}
{"type":"edit_script","path":"game.ServerScriptService.ScriptName","source":"-- complete new source"}
{"type":"create_instance","className":"Part","name":"MyPart","parent":"game.Workspace","properties":{"Size":[4,1,4],"Anchored":true,"BrickColor":"Bright red"}}
{"type":"delete_instance","path":"game.Workspace.PartName"}
{"type":"set_property","path":"game.Workspace.Part","property":"BrickColor","value":"Bright blue"}

STRICT RULES:
- ONLY respond with valid JSON. Nothing outside the JSON object ever.
- When fixing bugs, read the FULL script source provided and rewrite it completely fixed.
- Script names must be descriptive. Never name a script after the prompt.
- Write complete, working, production-quality Luau. No truncation, no placeholders.
- No markdown inside source fields — raw Luau only.
- Use proper Roblox services and patterns.
- If nothing needs doing in Studio, return actions: [].
- Always explain what you found/fixed in the reply field.`;

const SCAN_SYSTEM = `You are an expert Roblox game analyst with access to the full game source.
Analyze everything provided and respond in this exact format:

## 🗺️ Game Overview
[Type of game, core systems present, 2-3 sentences]

## 📁 Structure
[Every script and key instance with one-line description each]

## 🐛 Bugs Found
[Number each bug. Exact script name, what line/logic is broken, why it causes the bug, exact fix needed. If none: "No bugs found!"]

## ⚠️ Missing Systems
[What this game type usually needs but is absent]

## 💡 Suggestions
[3 concrete improvements with implementation details]

Be extremely specific. Reference exact script names, variable names, and line logic.`;

// ── BUILD CONTEXT-INJECTED MESSAGES ──────────────────────────────────────────
function buildMessages(userMessages, sessionToken, systemPrompt) {
  // Get stored game context for this session
  const ctx = gameContexts[sessionToken];
  const gameInfo = ctx
    ? `\n\n========== CURRENT GAME STATE (scanned ${Math.round((Date.now()-ctx.updatedAt)/1000)}s ago) ==========\n${ctx.context}\n========== END GAME STATE ==========`
    : "\n\n[No game context yet — plugin not connected or hasn't sent context]";

  const system = systemPrompt + gameInfo;

  // Inject context into last user message
  const msgs = [...userMessages].filter(m => m.role !== "system");
  if (msgs.length > 0 && msgs[msgs.length-1].role === "user") {
    // context already in system prompt, no need to duplicate
  }
  return [{ role: "system", content: system }, ...msgs];
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS, DELETE",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    res.end(); return;
  }

  const url = req.url.split("?")[0];
  const query = Object.fromEntries(new URL("http://x" + req.url).searchParams);

  // ── Health check ──────────────────────────────────────────────────────────
  if (url === "/" && req.method === "GET") {
    send(res, 200, {
      status: "Spark backend running",
      version: "2.1.0",
      sessions: Object.keys(sessions).length,
      contextsStored: Object.keys(gameContexts).length
    });
    return;
  }

  // ════════════════════════════════════════════════
  // AUTH
  // ════════════════════════════════════════════════

  // POST /auth/signup
  if (url === "/auth/signup" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const { username, email, password } = body;
      if (!username || !email || !password) return send(res, 400, { error: "All fields required" });
      if (password.length < 8) return send(res, 400, { error: "Password must be at least 8 characters" });
      if (users[email]) return send(res, 409, { error: "Email already registered" });
      const id = "u_" + crypto.randomBytes(8).toString("hex");
      users[email] = { id, username, email, passwordHash: hash(password), plan: "free", createdAt: Date.now() };
      const token = genToken();
      sessions[token] = { userId: id, email, username, plan: "free" };
      console.log(`[signup] ${email}`);
      send(res, 200, { token, user: { id, username, email, plan: "free" } });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // POST /auth/login
  if (url === "/auth/login" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const { email, password } = body;
      if (!email || !password) return send(res, 400, { error: "Email and password required" });
      const user = users[email];
      if (!user || user.passwordHash !== hash(password)) return send(res, 401, { error: "Invalid email or password" });
      const token = genToken();
      sessions[token] = { userId: user.id, email, username: user.username, plan: user.plan };
      console.log(`[login] ${email}`);
      send(res, 200, { token, user: { id: user.id, username: user.username, email, plan: user.plan } });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // POST /auth/validate
  if (url === "/auth/validate" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const session = sessions[body.sessionToken];
      if (!session) return send(res, 401, { valid: false, error: "Invalid session token" });
      send(res, 200, { valid: true, user: { username: session.username, email: session.email, plan: session.plan } });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════════
  // CONTEXT PUSH — plugin sends this every 10s
  // POST /context
  // ════════════════════════════════════════════════
  if (url === "/context" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const token = body.sessionToken || body.token;
      if (!token || !sessions[token]) return send(res, 401, { error: "Invalid session" });

      const context = body.context || "";
      gameContexts[token] = {
        context: context.slice(0, 80000), // cap at 80k chars
        updatedAt: Date.now()
      };

      // Update heartbeat too
      studioHeartbeat[token] = Date.now();

      console.log(`[context] stored ${context.length} chars for ...${token.slice(-8)}`);
      send(res, 200, { stored: true, chars: context.length });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════════
  // GENERATE
  // ════════════════════════════════════════════════
  if (url === "/generate" && req.method === "POST") {
    try {
      const body = await getBody(req);
      let userPlan = "free";
      const sessionToken = body.sessionToken;

      if (sessionToken) {
        const session = sessions[sessionToken];
        if (!session) return send(res, 401, { reply: "❌ Invalid session. Please log in again.", actions: [] });
        userPlan = session.plan;
      } else if (PLUGIN_TOKEN && body.token !== PLUGIN_TOKEN) {
        return send(res, 401, { reply: "❌ Invalid plugin token.", actions: [] });
      }

      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];
      if (model.tier === "paid" && userPlan !== "pro") {
        return send(res, 403, {
          reply: "🔒 This model requires a Pro subscription. Upgrade at website-six-bay-23.vercel.app",
          actions: []
        });
      }

      const userMsgs = body.messages || [{ role:"user", content: body.prompt || "" }];
      const messages = buildMessages(userMsgs, sessionToken, ACTION_SYSTEM);

      console.log(`[generate] model=${modelId} plan=${userPlan} context=${gameContexts[sessionToken] ? gameContexts[sessionToken].context.length + ' chars' : 'none'}`);

      const raw = await model.call(messages);
      let parsed = safeJSON(raw);
      if (!parsed) parsed = { reply: raw, actions: [] };
      if (!parsed.actions) parsed.actions = [];

      // Queue actions for studio
      if (sessionToken && parsed.actions.length > 0) {
        actionQueues[sessionToken] = { actions: parsed.actions, queuedAt: Date.now() };
      }

      send(res, 200, parsed);
    } catch(e) {
      console.error("[generate error]", e.message);
      send(res, 500, { reply: "⚠️ Error: " + e.message, actions: [] });
    }
    return;
  }

  // ════════════════════════════════════════════════
  // SCAN — deep analysis using stored context
  // ════════════════════════════════════════════════
  if (url === "/scan" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const sessionToken = body.sessionToken;
      let userPlan = "free";
      if (sessionToken) {
        const session = sessions[sessionToken];
        if (!session) return send(res, 401, { error: "Invalid session" });
        userPlan = session.plan;
      }

      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];
      if (model.tier === "paid" && userPlan !== "pro") {
        return send(res, 403, { analysis: "🔒 Pro required for this model." });
      }

      // Use stored context OR context sent in request (fallback)
      const stored = gameContexts[sessionToken];
      const context = stored ? stored.context : (body.context || "No game context available");

      const messages = [
        { role: "system", content: SCAN_SYSTEM },
        { role: "user", content: `Analyze my full Roblox game:\n\n${context}` }
      ];

      console.log(`[scan] context=${context.length} chars`);
      const analysis = await model.call(messages);
      send(res, 200, { analysis });
    } catch(e) { send(res, 500, { analysis: "⚠️ Error: " + e.message }); }
    return;
  }

  // ════════════════════════════════════════════════
  // PLAN
  // ════════════════════════════════════════════════
  if (url === "/plan" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const sessionToken = body.sessionToken;
      let userPlan = "free";
      if (sessionToken) {
        const s = sessions[sessionToken];
        if (!s) return send(res, 401, { error: "Invalid session" });
        userPlan = s.plan;
      }
      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];
      if (model.tier === "paid" && userPlan !== "pro") return send(res, 403, { error: "Pro required" });

      const stored = gameContexts[sessionToken];
      const context = stored ? stored.context : (body.context || "Empty game");

      const messages = [
        { role:"system", content:`You are a Roblox game architect. Respond ONLY with JSON:
{"title":"Game Name","description":"One sentence","steps":[{"id":1,"title":"Step","description":"Exactly what to build","type":"script|world|both"}]}
5-8 specific implementable steps. No markdown outside JSON.` },
        { role:"user", content:`Game idea: ${body.idea}\n\nCurrent game:\n${context}` }
      ];
      let raw = await model.call(messages);
      let plan = safeJSON(raw);
      if (!plan) plan = { title: body.idea, description: "", steps: [] };
      send(res, 200, plan);
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════════
  // STEP
  // ════════════════════════════════════════════════
  if (url === "/step" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const sessionToken = body.sessionToken;
      let userPlan = "free";
      if (sessionToken) {
        const s = sessions[sessionToken];
        if (!s) return send(res, 401, { error: "Invalid session" });
        userPlan = s.plan;
      }
      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];
      if (model.tier === "paid" && userPlan !== "pro") return send(res, 403, { reply: "Pro required", actions: [] });

      const stored = gameContexts[sessionToken];
      const context = stored ? stored.context : (body.context || "Empty game");

      const messages = [
        { role:"system", content: ACTION_SYSTEM },
        { role:"user", content:`Implement step ${body.stepId} of this Roblox game.
Plan:\n${body.steps.map((s,i)=>`${i+1}. ${s.title}: ${s.description}`).join("\n")}
Current game:\n${context}
Done so far:\n${body.history||"Nothing yet"}
NOW implement step ${body.stepId}: "${body.step.title}" — ${body.step.description}
Create ALL necessary scripts and instances. Write complete working Luau code.` }
      ];
      let raw = await model.call(messages);
      let result = safeJSON(raw);
      if (!result) result = { reply: raw, actions: [] };
      if (sessionToken && result.actions?.length > 0) {
        actionQueues[sessionToken] = { actions: result.actions, queuedAt: Date.now() };
      }
      send(res, 200, result);
    } catch(e) { send(res, 500, { reply: "Error: " + e.message, actions: [] }); }
    return;
  }

  // ════════════════════════════════════════════════
  // ACTION QUEUE
  // ════════════════════════════════════════════════

  // POST /queue — website manually pushes actions
  if (url === "/queue" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const token = body.sessionToken;
      if (!token || !sessions[token]) return send(res, 401, { error: "Invalid session" });
      actionQueues[token] = { actions: body.actions || [], queuedAt: Date.now() };
      send(res, 200, { queued: true });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // GET /poll?token=xxx — plugin polls for pending actions
  if (url === "/poll" && req.method === "GET") {
    const token = query.token;
    if (!token || !sessions[token]) return send(res, 401, { error: "Invalid session" });
    studioHeartbeat[token] = Date.now();
    const queue = actionQueues[token];
    if (queue && queue.actions.length > 0) {
      const actions = queue.actions;
      delete actionQueues[token];
      console.log(`[poll] Delivered ${actions.length} actions to ...${token.slice(-8)}`);
      send(res, 200, { actions });
    } else {
      send(res, 200, { actions: [] });
    }
    return;
  }

  // GET /status?token=xxx — website checks studio connection
  if (url === "/status" && req.method === "GET") {
    const token = query.token;
    if (!token) return send(res, 400, { error: "Token required" });
    const lastSeen = studioHeartbeat[token];
    const connected = lastSeen && (Date.now() - lastSeen) < 15000;
    const ctx = gameContexts[token];
    send(res, 200, {
      connected: !!connected,
      lastSeen: lastSeen || null,
      hasContext: !!ctx,
      contextAge: ctx ? Math.round((Date.now() - ctx.updatedAt) / 1000) : null,
      contextSize: ctx ? ctx.context.length : 0
    });
    return;
  }

  // ── 404 ──
  send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Spark backend v2.1 running on port ${PORT}`);
  console.log(`Models: ${Object.keys(MODELS).join(", ")}`);
});
