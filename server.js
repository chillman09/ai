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
  if (!raw) return null;
  // 1. direct parse
  try { return JSON.parse(raw.trim()); } catch(e) {}
  // 2. strip markdown fences
  try { const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/); if (m) return JSON.parse(m[1].trim()); } catch(e) {}
  // 3. find first { to last }
  try {
    const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
    if (s !== -1 && e > s) return JSON.parse(raw.slice(s, e+1));
  } catch(e) {}
  // 4. fix trailing commas then retry
  try {
    let fixed = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}")+1);
    fixed = fixed.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(fixed);
  } catch(e) {}
  return null;
}

async function callWithRetry(model, messages) {
  const raw = await model.call(messages);
  let parsed = safeJSON(raw);
  if (!parsed) parsed = { reply: raw, actions: [] };
  if (!parsed.actions) parsed.actions = [];

  // If reply mentions doing something but actions is empty — retry
  const replyLower = (parsed.reply || "").toLowerCase();
  const mentionsAction = replyLower.includes("fix") || replyLower.includes("delet") || replyLower.includes("edit") || replyLower.includes("creat") || replyLower.includes("remov");
  if (parsed.actions.length === 0 && mentionsAction) {
    console.log("[retry] actions empty but reply mentions changes — retrying...");
    const retryMsgs = [
      ...messages,
      { role: "assistant", content: raw },
      { role: "user", content: "You said you would make changes but your actions array was empty. Return the JSON again but this time POPULATE the actions array with all the actual changes. Every change MUST be in the actions array." }
    ];
    const raw2 = await model.call(retryMsgs);
    const p2 = safeJSON(raw2);
    if (p2 && p2.actions && p2.actions.length > 0) {
      console.log("[retry] success — got " + p2.actions.length + " actions");
      return p2;
    }
  }
  return parsed;
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
You have full knowledge of the user's game provided in this prompt.

YOUR RESPONSE MUST BE A SINGLE RAW JSON OBJECT. NO EXCEPTIONS.
DO NOT write any text before or after the JSON.
DO NOT use markdown code blocks. DO NOT say "Here is..." or "I will...".
START your response with { and END with }. Nothing else.

Required format:
{"reply":"what you did in 1-2 sentences","actions":[]}

Action types you can use:
{"type":"create_script","scriptType":"Script","name":"ScriptName","parent":"game.ServerScriptService","source":"-- luau code here"}
{"type":"edit_script","path":"game.ServerScriptService.ExistingScriptName","source":"-- complete rewritten source"}
{"type":"create_instance","className":"Part","name":"PartName","parent":"game.Workspace","properties":{"Size":[4,1,4],"Anchored":true}}
{"type":"delete_instance","path":"game.ServerScriptService.ScriptName"}
{"type":"set_property","path":"game.Workspace.Part","property":"BrickColor","value":"Bright red"}

RULES YOU MUST FOLLOW:
1. Your ENTIRE response is one JSON object starting with { — no other text
2. To fix a bug: use edit_script with the COMPLETE rewritten script source — no placeholders, no "-- rest of code here"
3. To delete something: use delete_instance with the exact full path
4. Script source must be complete working Luau — never truncated
5. Use exact paths from the game context provided
6. Put ALL fixes/changes in the actions array — if you say you did something, it MUST be in actions
7. Never describe what you will do — just DO it in the actions array`;

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

      const parsed = await callWithRetry(model, messages);

      // Queue actions for studio
      if (sessionToken && parsed.actions.length > 0) {
        actionQueues[sessionToken] = { actions: parsed.actions, queuedAt: Date.now() };
        console.log('[generate] queued ' + parsed.actions.length + ' actions');
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


  // ════════════════════════════════════════════════
  // AGENT — Lemonade-style multi-step agent loop
  // POST /agent
  // ════════════════════════════════════════════════
  if (url === "/agent" && req.method === "POST") {
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
        return send(res, 403, { error: "Pro required for this model" });
      }

      const userMessage = body.message || "";
      const ctx = gameContexts[sessionToken];
      const gameInfo = ctx
        ? `\n\n========== GAME STATE (${Math.round((Date.now()-ctx.updatedAt)/1000)}s ago) ==========\n${ctx.context}\n========== END ==========`
        : "\n\n[No game context — plugin not connected]";

      // ── PHASE 1: CLASSIFY — should we show options or just do it? ──
      const classifyMessages = [
        { role: "system", content: `You classify user requests about a Roblox game. Respond ONLY with JSON, no other text.

If the request is AMBIGUOUS (multiple valid approaches, user should choose where to start):
{"type":"options","options":["option 1 description","option 2 description","option 3 description"]}
Max 4 options. Always make the last option exactly: "Something else — I'll describe it"

If the request is CLEAR (one obvious thing to do, or user already specified exactly what):
{"type":"direct"}

Examples of AMBIGUOUS: "make a battle royale", "fix all bugs", "add multiplayer", "improve my game"
Examples of DIRECT: "add a leaderboard", "fix the killbrick debounce bug", "create a checkpoint system", "delete the TestScript"
` + gameInfo },
        { role: "user", content: userMessage }
      ];

      const classifyRaw = await model.call(classifyMessages);
      const classified = safeJSON(classifyRaw);

      if (classified && classified.type === "options") {
        // Return options for user to pick
        return send(res, 200, {
          phase: "options",
          question: "Let's get started. Which part should we build first?",
          options: classified.options
        });
      }

      // ── PHASE 2: INVESTIGATE + PLAN ──
      const planMessages = [
        { role: "system", content: `You are Spark, a Roblox Studio AI agent. You have full access to the game.
Analyze the request and create an investigation + execution plan.
Respond ONLY with JSON:
{
  "summary": "One sentence: what you're going to do",
  "investigations": [
    {"action": "read_script", "target": "game.ServerScriptService.ScriptName", "reason": "why"},
    {"action": "list_children", "target": "game.Workspace", "reason": "why"},
    {"action": "find_instance", "target": "PartName", "reason": "why"}
  ],
  "steps": [
    {"id": 1, "title": "Step title", "description": "Exactly what will be done"}
  ]
}
investigations: what you need to check in the game first (0-4 items, only what's actually needed)
steps: 1-5 concrete implementation steps
` + gameInfo },
        { role: "user", content: userMessage }
      ];

      const planRaw = await model.call(planMessages);
      const plan = safeJSON(planRaw);
      if (!plan) return send(res, 500, { error: "Failed to plan" });

      // ── PHASE 3: EXECUTE — do the actual work ──
      // Build investigation results from stored context
      const investigationResults = [];
      if (plan.investigations && ctx) {
        for (const inv of (plan.investigations || [])) {
          let result = "";
          if (inv.action === "read_script") {
            // Find script source in stored context
            const scriptName = inv.target.split(".").pop();
            const scriptMatch = ctx.context.match(
              new RegExp(`--- PATH: [^\\n]*${scriptName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[^\\n]* ---\\n([\\s\\S]*?)(?=\\n--- PATH:|\\n=== |$)`, 'i')
            );
            result = scriptMatch ? `Source of ${scriptName}:\n${scriptMatch[1].slice(0,3000)}` : `Script ${scriptName} not found in context`;
          } else if (inv.action === "list_children") {
            const svcName = inv.target.split(".").pop();
            const svcMatch = ctx.context.match(new RegExp(`=== ${svcName} ===([\\s\\S]*?)(?=\\n===|$)`, 'i'));
            result = svcMatch ? `Children of ${svcName}:${svcMatch[1].slice(0,1000)}` : `${svcName} not found`;
          } else if (inv.action === "find_instance") {
            const instName = inv.target;
            result = ctx.context.includes(instName) ? `Found: ${instName} exists in game` : `Not found: ${instName} does not exist`;
          }
          investigationResults.push({ ...inv, result });
        }
      }

      // Now do the actual implementation
      const executeMessages = [
        { role: "system", content: `You are Spark, a Roblox Studio AI agent. Implement the requested changes now.

YOUR RESPONSE MUST BE A SINGLE RAW JSON OBJECT STARTING WITH { — NO OTHER TEXT.

Format:
{
  "actions": [],
  "summary": "What you built in 2-3 sentences",
  "changes": [
    {"type":"created|edited|deleted", "path":"game.ServerScriptService.ScriptName", "description":"what it does"}
  ],
  "details": [
    {"label":"Spawn Rate","value":"Every 3 seconds"},
    {"label":"How to adjust","value":"Change SPAWN_INTERVAL at top of BrainrotSpawner"}
  ]
}

Available actions:
{"type":"create_script","scriptType":"Script|LocalScript|ModuleScript","name":"Name","parent":"game.ServerScriptService","source":"-- complete luau"}
{"type":"edit_script","path":"game.ServerScriptService.ScriptName","source":"-- complete rewritten source"}
{"type":"create_instance","className":"Part","name":"Name","parent":"game.Workspace","properties":{"Size":[4,1,4],"Anchored":true}}
{"type":"delete_instance","path":"game.ServerScriptService.ScriptName"}
{"type":"set_property","path":"game.Workspace.Part","property":"BrickColor","value":"Bright red"}

RULES:
- Start response with { immediately
- Write COMPLETE Luau source — never truncated, never placeholder comments
- Use exact instance paths from game context
- actions array must contain every actual change
- changes array summarizes what was done (for the UI)
- details array shows config values user might want to tweak
` + gameInfo + (investigationResults.length > 0 ? `\n\nINVESTIGATION RESULTS:\n${investigationResults.map(i=>`${i.action} ${i.target}: ${i.result}`).join('\n')}` : '') },
        { role: "user", content: `User request: ${userMessage}\n\nPlan:\n${(plan.steps||[]).map((s,i)=>`${i+1}. ${s.title}: ${s.description}`).join('\n')}\n\nNow implement all of this completely.` }
      ];

      const execRaw = await model.call(executeMessages);
      let execResult = safeJSON(execRaw);

      // Retry if actions empty but there should be some
      if (!execResult || (execResult.actions && execResult.actions.length === 0)) {
        console.log("[agent] retry — no actions in first attempt");
        const retry = await model.call([
          ...executeMessages,
          { role: "assistant", content: execRaw || "" },
          { role: "user", content: "Your actions array is empty. You MUST populate it with the actual create_script/edit_script/create_instance actions. Return the JSON again with actions filled in." }
        ]);
        const r2 = safeJSON(retry);
        if (r2 && r2.actions && r2.actions.length > 0) execResult = r2;
      }

      if (!execResult) execResult = { actions: [], summary: execRaw, changes: [], details: [] };
      if (!execResult.actions) execResult.actions = [];

      // Queue actions for studio
      if (sessionToken && execResult.actions.length > 0) {
        actionQueues[sessionToken] = { actions: execResult.actions, queuedAt: Date.now() };
        console.log(`[agent] queued ${execResult.actions.length} actions`);
      }

      // Push fresh context request after changes
      // (plugin will push on next interval)

      send(res, 200, {
        phase: "complete",
        plan: {
          summary: plan.summary || "",
          investigations: investigationResults,
          steps: plan.steps || []
        },
        actions: execResult.actions,
        summary: execResult.summary || "",
        changes: execResult.changes || [],
        details: execResult.details || []
      });

    } catch(e) {
      console.error("[agent error]", e.message);
      send(res, 500, { error: e.message });
    }
    return;
  }

  // POST /agent/option — user picked an option, now execute it
  if (url === "/agent/option" && req.method === "POST") {
    try {
      const body = await getBody(req);
      // Just forward as a direct agent call with the chosen option as the message
      body.message = body.option;
      // Re-route to agent handler by recursion trick — just call generate directly
      const sessionToken = body.sessionToken;
      let userPlan = "free";
      if (sessionToken) {
        const session = sessions[sessionToken];
        if (!session) return send(res, 401, { error: "Invalid session" });
        userPlan = session.plan;
      }
      const modelId = body.model || "glm5";
      const model = MODELS[modelId] || MODELS["glm5"];
      if (model.tier === "paid" && userPlan !== "pro") return send(res, 403, { error: "Pro required" });

      const ctx = gameContexts[sessionToken];
      const gameInfo = ctx
        ? `\n\n========== GAME STATE ==========\n${ctx.context}\n========== END ==========`
        : "\n\n[No game context]";

      const planMessages = [
        { role: "system", content: `You are Spark. Create an investigation + execution plan for this specific task.
Respond ONLY with JSON:
{"summary":"what you're doing","investigations":[{"action":"read_script|list_children|find_instance","target":"path","reason":"why"}],"steps":[{"id":1,"title":"title","description":"what"}]}
` + gameInfo },
        { role: "user", content: body.option }
      ];
      const planRaw = await model.call(planMessages);
      const plan = safeJSON(planRaw) || { summary: body.option, investigations: [], steps: [{ id:1, title: "Implement", description: body.option }] };

      const investigationResults = [];
      if (plan.investigations && ctx) {
        for (const inv of plan.investigations) {
          let result = "";
          if (inv.action === "read_script") {
            const scriptName = inv.target.split(".").pop();
            const scriptMatch = ctx.context.match(new RegExp(`--- PATH: [^\\n]*${scriptName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}[^\\n]* ---\\n([\\s\\S]*?)(?=\\n--- PATH:|\\n=== |$)`,'i'));
            result = scriptMatch ? `Source:\n${scriptMatch[1].slice(0,3000)}` : `Not found`;
          } else if (inv.action === "list_children") {
            const svcName = inv.target.split(".").pop();
            const svcMatch = ctx.context.match(new RegExp(`=== ${svcName} ===([\\s\\S]*?)(?=\\n===|$)`,'i'));
            result = svcMatch ? svcMatch[1].slice(0,1000) : "Not found";
          } else if (inv.action === "find_instance") {
            result = ctx && ctx.context.includes(inv.target) ? `Found: ${inv.target}` : `Not found: ${inv.target}`;
          }
          investigationResults.push({ ...inv, result });
        }
      }

      const executeMessages = [
        { role: "system", content: `You are Spark. Implement now. Respond ONLY with JSON starting with {:
{"actions":[],"summary":"what you built","changes":[{"type":"created|edited|deleted","path":"...","description":"..."}],"details":[{"label":"...","value":"..."}]}

Actions: create_script, edit_script, create_instance, delete_instance, set_property
Write COMPLETE Luau. No truncation. Start with {.
` + gameInfo + (investigationResults.length > 0 ? `\n\nINVESTIGATION:\n${investigationResults.map(i=>`${i.action} ${i.target}: ${i.result}`).join('\n')}` : '') },
        { role: "user", content: `Task: ${body.option}\n\nSteps:\n${plan.steps.map((s,i)=>`${i+1}. ${s.title}: ${s.description}`).join('\n')}\n\nImplement everything now.` }
      ];

      const execRaw = await model.call(executeMessages);
      let execResult = safeJSON(execRaw) || { actions: [], summary: execRaw, changes: [], details: [] };
      if (!execResult.actions) execResult.actions = [];

      if (sessionToken && execResult.actions.length > 0) {
        actionQueues[sessionToken] = { actions: execResult.actions, queuedAt: Date.now() };
      }

      send(res, 200, {
        phase: "complete",
        plan: { summary: plan.summary, investigations: investigationResults, steps: plan.steps },
        actions: execResult.actions,
        summary: execResult.summary || "",
        changes: execResult.changes || [],
        details: execResult.details || []
      });
    } catch(e) {
      send(res, 500, { error: e.message });
    }
    return;
  }

  // ── 404 ──
  send(res, 404, { error: "Not found" });
});

server.listen(PORT, () => {
  console.log(`Spark backend v2.1 running on port ${PORT}`);
  console.log(`Models: ${Object.keys(MODELS).join(", ")}`);
});
