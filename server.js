const http = require("http");
const https = require("https");
const crypto = require("crypto");
const PORT = process.env.PORT || 3000;

// ── ENV ───────────────────────────────────────────────────────────────────────
const OLLAMA_KEY     = process.env.OLLAMA_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const JWT_SECRET     = process.env.JWT_SECRET || "spark-secret-change-me";
const PLUGIN_TOKEN   = process.env.PLUGIN_TOKEN;

// ── IN-MEMORY STORES (swap for DB later) ─────────────────────────────────────
// users: { [email]: { id, username, email, passwordHash, plan, createdAt } }
const users = {};
// sessions: { [token]: { userId, email, username, plan, createdAt } }
const sessions = {};
// action queues: { [token]: { actions[], queuedAt } }
const actionQueues = {};
// studio heartbeat: { [token]: lastSeen timestamp }
const studioHeartbeat = {};

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
function getSession(body, req) {
  const token = body?.sessionToken ||
    req.headers["authorization"]?.replace("Bearer ", "") ||
    body?.token;
  return token ? sessions[token] : null;
}
function safeJSON(raw) {
  try {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const s = m ? m[1] : raw;
    const o = s.match(/\{[\s\S]*\}/);
    return JSON.parse(o ? o[0] : s);
  } catch(e) { return null; }
}

// ── AI CALLERS ────────────────────────────────────────────────────────────────
async function callOllama(model, messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ model, messages, stream: false });
    const req = https.request({
      hostname: "ollama.com", path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + OLLAMA_KEY, "Content-Length": Buffer.byteLength(payload) }
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

async function callOpenRouter(model, messages) {
  if (!OPENROUTER_KEY) throw new Error("OPENROUTER_KEY not configured");
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

const MODELS = {
  "glm5":     { tier:"free", call: m => callOllama("glm-5:cloud", m) },
  "llama31":  { tier:"free", call: m => callOllama("llama3.1:8b", m) },
  "gpt4o":    { tier:"paid", call: m => callOpenRouter("openai/gpt-4o", m) },
  "claude35": { tier:"paid", call: m => callOpenRouter("anthropic/claude-3.5-sonnet", m) },
  "grok3":    { tier:"paid", call: m => callOpenRouter("x-ai/grok-3-mini-beta", m) },
  "gemini25": { tier:"paid", call: m => callOpenRouter("google/gemini-2.5-pro-preview", m) },
};

const ACTION_SYSTEM = `You are an AI assistant inside Roblox Studio. You control the game directly.

Respond ONLY with a JSON object:
{
  "reply": "Short friendly message to the user",
  "actions": []
}

Available actions:
{"type":"create_script","scriptType":"Script|LocalScript|ModuleScript","name":"ProperName","parent":"game.ServerScriptService","source":"-- code"}
{"type":"edit_script","path":"game.ServerScriptService.Name","source":"-- full new source"}
{"type":"create_instance","className":"Part","name":"MyPart","parent":"game.Workspace","properties":{"Size":[4,1,4],"Anchored":true,"BrickColor":"Bright red"}}
{"type":"delete_instance","path":"game.Workspace.PartName"}
{"type":"set_property","path":"game.Workspace.Part","property":"BrickColor","value":"Bright blue"}

RULES:
- ALWAYS valid JSON only. Nothing outside it.
- Script names must be descriptive, never named after the prompt.
- Complete working production-quality Luau. No markdown in source.
- If nothing needed, actions: [].`;

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS preflight
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

  // ── GET / ── health
  if (url === "/" && req.method === "GET") {
    send(res, 200, { status: "Spark backend running", version: "2.0.0" }); return;
  }

  // ════════════════════════════════════════════
  // AUTH ENDPOINTS
  // ════════════════════════════════════════════

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

  // POST /auth/validate (plugin uses this to check token)
  if (url === "/auth/validate" && req.method === "POST") {
    try {
      const body = await getBody(req);
      const session = sessions[body.sessionToken];
      if (!session) return send(res, 401, { valid: false, error: "Invalid session token" });
      send(res, 200, { valid: true, user: { username: session.username, email: session.email, plan: session.plan } });
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════
  // AI GENERATE
  // ════════════════════════════════════════════
  if (url === "/generate" && req.method === "POST") {
    try {
      const body = await getBody(req);

      // Auth — allow both session token (website) and plugin token (old plugin)
      let userPlan = "free";
      if (body.sessionToken) {
        const session = sessions[body.sessionToken];
        if (!session) return send(res, 401, { error: "Invalid session token" });
        userPlan = session.plan;
      } else if (PLUGIN_TOKEN && body.token !== PLUGIN_TOKEN) {
        return send(res, 401, { reply: "❌ Invalid plugin token.", actions: [] });
      }

      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];

      if (model.tier === "paid" && userPlan !== "pro") {
        return send(res, 403, { reply: "🔒 This model requires a Pro subscription. Upgrade at website-six-bay-23.vercel.app", actions: [] });
      }

      const msgs = body.messages || [{ role:"user", content: body.prompt || "" }];
      const messages = [{ role:"system", content: ACTION_SYSTEM }, ...msgs.filter(m => m.role !== "system")];

      console.log(`[generate] model=${modelId} plan=${userPlan}`);
      const raw = await model.call(messages);
      let parsed = safeJSON(raw);
      if (!parsed) parsed = { reply: raw, actions: [] };

      // Auto-queue actions for studio if session token given
      if (body.sessionToken && parsed.actions && parsed.actions.length > 0) {
        actionQueues[body.sessionToken] = {
          actions: parsed.actions,
          queuedAt: Date.now()
        };
      }

      send(res, 200, parsed);
    } catch(e) {
      console.error("[generate error]", e.message);
      send(res, 500, { reply: "Error: " + e.message, actions: [] });
    }
    return;
  }

  // ════════════════════════════════════════════
  // SCAN
  // ════════════════════════════════════════════
  if (url === "/scan" && req.method === "POST") {
    try {
      const body = await getBody(req);
      let userPlan = "free";
      if (body.sessionToken) {
        const session = sessions[body.sessionToken];
        if (!session) return send(res, 401, { error: "Invalid session" });
        userPlan = session.plan;
      }
      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];
      if (model.tier === "paid" && userPlan !== "pro") {
        return send(res, 403, { analysis: "🔒 Pro required for this model." });
      }
      const messages = [
        { role:"system", content:`You are an expert Roblox game analyst. Respond in this exact format:

## 🗺️ Game Overview
[Type of game, what systems, 2-3 sentences]

## 📁 Structure
[Every script and key instance with one-line description]

## 🐛 Bugs Found
[Number each bug. What it is, why it breaks, exact fix. "No bugs found!" if none]

## ⚠️ Missing Systems
[What this game type usually needs but doesn't have]

## 💡 Suggestions
[2-3 concrete improvements]

Be specific. Reference actual script names and paths.` },
        { role:"user", content:"My full game:\n\n" + body.context }
      ];
      const analysis = await model.call(messages);
      send(res, 200, { analysis });
    } catch(e) { send(res, 500, { analysis: "Error: " + e.message }); }
    return;
  }

  // ════════════════════════════════════════════
  // PLAN
  // ════════════════════════════════════════════
  if (url === "/plan" && req.method === "POST") {
    try {
      const body = await getBody(req);
      let userPlan = "free";
      if (body.sessionToken) {
        const s = sessions[body.sessionToken];
        if (!s) return send(res, 401, { error: "Invalid session" });
        userPlan = s.plan;
      }
      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];
      if (model.tier === "paid" && userPlan !== "pro") {
        return send(res, 403, { error: "Pro required" });
      }
      const messages = [
        { role:"system", content:`You are a Roblox game architect. Respond ONLY with JSON:
{"title":"Game Name","description":"One sentence","steps":[{"id":1,"title":"Step","description":"Exactly what to build","type":"script|world|both"}]}
5-8 specific steps. No markdown outside JSON.` },
        { role:"user", content:"Game idea: " + body.idea + "\n\nCurrent game:\n" + (body.context || "Empty") }
      ];
      let raw = await model.call(messages);
      let plan = safeJSON(raw);
      if (!plan) plan = { title: body.idea, description: "", steps: [] };
      send(res, 200, plan);
    } catch(e) { send(res, 500, { error: e.message }); }
    return;
  }

  // ════════════════════════════════════════════
  // STEP
  // ════════════════════════════════════════════
  if (url === "/step" && req.method === "POST") {
    try {
      const body = await getBody(req);
      let userPlan = "free";
      if (body.sessionToken) {
        const s = sessions[body.sessionToken];
        if (!s) return send(res, 401, { error: "Invalid session" });
        userPlan = s.plan;
      }
      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];
      if (model.tier === "paid" && userPlan !== "pro") {
        return send(res, 403, { reply: "Pro required", actions: [] });
      }
      const messages = [
        { role:"system", content: ACTION_SYSTEM },
        { role:"user", content:`Implement step ${body.stepId} of this Roblox game.
Plan:\n${body.steps.map((s,i)=>`${i+1}. ${s.title}: ${s.description}`).join("\n")}
Current game:\n${body.context}
Done so far:\n${body.history||"Nothing yet"}
NOW implement step ${body.stepId}: "${body.step.title}" — ${body.step.description}
Create ALL necessary scripts and instances.` }
      ];
      let raw = await model.call(messages);
      let result = safeJSON(raw);
      if (!result) result = { reply: raw, actions: [] };

      if (body.sessionToken && result.actions?.length > 0) {
        actionQueues[body.sessionToken] = { actions: result.actions, queuedAt: Date.now() };
      }
      send(res, 200, result);
    } catch(e) { send(res, 500, { reply: "Error: " + e.message, actions: [] }); }
    return;
  }

  // ════════════════════════════════════════════
  // ACTION QUEUE (plugin polls this)
  // ════════════════════════════════════════════

  // POST /queue — website pushes actions for studio
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

    // Update heartbeat
    studioHeartbeat[token] = Date.now();

    const queue = actionQueues[token];
    if (queue && queue.actions.length > 0) {
      const actions = queue.actions;
      delete actionQueues[token]; // clear after delivering
      console.log(`[poll] Delivered ${actions.length} actions to studio for token ...${token.slice(-8)}`);
      send(res, 200, { actions });
    } else {
      send(res, 200, { actions: [] });
    }
    return;
  }

  // GET /status?token=xxx — check if studio is connected (website polls this)
  if (url === "/status" && req.method === "GET") {
    const token = query.token;
    if (!token) return send(res, 400, { error: "Token required" });
    const lastSeen = studioHeartbeat[token];
    const connected = lastSeen && (Date.now() - lastSeen) < 15000; // 15s timeout
    send(res, 200, { connected: !!connected, lastSeen: lastSeen || null });
    return;
  }

  // ════════════════════════════════════════════
  // OLD PLUGIN COMPAT (validate license key)
  // ════════════════════════════════════════════
  if (url === "/validate" && req.method === "POST") {
    try {
      const body = await getBody(req);
      if (PLUGIN_TOKEN && body.token !== PLUGIN_TOKEN) return send(res, 401, { valid: false, message: "❌ Invalid plugin token." });
      const session = sessions[body.sessionToken || body.licenseKey];
      const valid = !!session;
      send(res, 200, { valid, message: valid ? "✅ License activated!" : "❌ Invalid session token." });
    } catch(e) { send(res, 500, { valid: false, message: e.message }); }
    return;
  }

  // ── 404 ──
  send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Spark backend v2 running on port ${PORT}`);
  console.log(`Models: ${Object.keys(MODELS).join(", ")}`);
});
