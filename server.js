const express = require("express");
const axios = require("axios");

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

// CONFIG: Set these in Railway environment variables
const TARGET_API_KEY = process.env.TARGET_API_KEY || "";  // Your iflow.cn sk-...
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || "https://apis.iflow.cn/v1";
const MODEL = process.env.MODEL || "kimi-k2";

app.get("/health", (req, res) => {
  res.json({ status: "ok", model: MODEL, target: TARGET_BASE_URL });
});

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [{ id: MODEL, object: "model", created: Date.now(), owned_by: "iflow-proxy" }],
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  // LOG EVERYTHING FROM JANITOR.AI
  console.log("\n========== INCOMING REQUEST FROM JANITOR.AI ==========");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));
  console.log("=====================================================\n");

  try {
    const { messages, stream, max_tokens, temperature, model } = req.body;

    const payload = {
      model: model || MODEL,
      messages: messages,
      temperature: temperature !== undefined ? temperature : 0.7,
      stream: stream !== undefined ? stream : false,
      ...(max_tokens && max_tokens > 0 ? { max_tokens } : {}),
    };

    // FORWARD TO IFLOW.CN
    const response = await axios.post(
      `${TARGET_BASE_URL}/chat/completions`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${TARGET_API_KEY}`,
          "Content-Type": "application/json",
          Accept: "application/json",  // Force this to avoid 406
        },
        responseType: "json",
        timeout: 300000,
      }
    );

    console.log("iflow.cn response status:", response.status);
    res.json(response.data);

  } catch (err) {
    console.error("Proxy error:", err.response?.status, err.response?.data || err.message);
    const status = err.response?.status || 500;
    const message = err.response?.data || { error: err.message };
    res.status(status).json(message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Target: ${TARGET_BASE_URL}`);
  console.log(`Model: ${MODEL}`);
});
