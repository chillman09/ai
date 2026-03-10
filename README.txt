# AI Assistant Plugin - Backend Server

This is the backend for the Roblox Studio AI Assistant Plugin.
It receives prompts from the plugin and returns Luau code using Claude (Anthropic API).

---

## Deploy for FREE on Railway (recommended, 5 minutes)

1. Go to https://railway.app and sign up (free)
2. Click "New Project" > "Deploy from GitHub repo"
   - OR click "New Project" > "Empty Project" > "Add Service" > "GitHub Repo"
3. Upload these two files (server.js and package.json) to a GitHub repo first
4. In Railway, go to your service > "Variables" tab
5. Add this environment variable:
      ANTHROPIC_API_KEY = your_key_here
6. Railway will give you a public URL like:
      https://your-app.up.railway.app
7. Copy that URL and paste it into the Roblox plugin script:
      local BACKEND_URL = "https://your-app.up.railway.app/generate"

---

## Get your Anthropic API Key

1. Go to https://console.anthropic.com
2. Sign up / log in
3. Click "API Keys" > "Create Key"
4. Copy the key and paste it as the ANTHROPIC_API_KEY variable in Railway

---

## Test it locally first (optional)

  ANTHROPIC_API_KEY=your_key node server.js

Then visit http://localhost:3000 — you should see "AI Assistant Plugin Backend is running!"

---

## How it works

  Roblox Studio Plugin
        |
        | POST /generate  { prompt: "make a coin script" }
        v
  This Node.js Server
        |
        | POST api.anthropic.com/v1/messages
        v
  Claude AI
        |
        | returns Luau code
        v
  Plugin inserts script into your game
