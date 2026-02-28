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

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY || "";
const NVIDIA_BASE_URL =
  process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
const MODEL = process.env.MODEL || "deepseek-ai/deepseek-r1";
const SHOW_REASONING = process.env.SHOW_REASONING === "true";
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || "4096");
const TEMPERATURE = parseFloat(process.env.TEMPERATURE || "0.6");

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", model: MODEL, show_reasoning: SHOW_REASONING });
});

// Models list
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: MODEL,
        object: "model",
        created: Date.now(),
        owned_by: "nvidia-nim-proxy",
      },
    ],
  });
});

// Chat completions
app.post("/v1/chat/completions", async (req, res) => {
  try {
    const { messages, stream, max_tokens, temperature, model } = req.body;

    const payload = {
      model: model || MODEL,
      messages: messages,
      max_tokens: max_tokens || MAX_TOKENS,
      temperature: temperature !== undefined ? temperature : TEMPERATURE,
      stream: stream !== undefined ? stream : true,
    };

    const response = await axios.post(
      `${NVIDIA_BASE_URL}/chat/completions`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NVIDIA_API_KEY}`,
          "Content-Type": "application/json",
          Accept: payload.stream ? "text/event-stream" : "application/json",
        },
        responseType: payload.stream ? "stream" : "json",
        timeout: 300000,
      }
    );

    if (payload.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      let buffer = "";
      let reasoningBuffer = "";
      let inReasoning = false;
      let reasoningSent = false;

      response.data.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            res.write("data: [DONE]\n\n");
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta || {};

            // Handle reasoning_content field (DeepSeek style)
            if (delta.reasoning_content && SHOW_REASONING) {
              if (!inReasoning) {
                inReasoning = true;
                // Send opening think tag
                const thinkStart = {
                  ...parsed,
                  choices: [
                    {
                      ...parsed.choices[0],
                      delta: { content: "<think>\n" },
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(thinkStart)}\n\n`);
              }
              const reasoningChunk = {
                ...parsed,
                choices: [
                  {
                    ...parsed.choices[0],
                    delta: { content: delta.reasoning_content },
                  },
                ],
              };
              res.write(`data: ${JSON.stringify(reasoningChunk)}\n\n`);
            } else if (delta.reasoning_content && !SHOW_REASONING) {
              // Skip reasoning silently
              continue;
            } else {
              // Close think tag if we were in reasoning
              if (inReasoning && !reasoningSent) {
                inReasoning = false;
                reasoningSent = true;
                const thinkEnd = {
                  ...parsed,
                  choices: [
                    {
                      ...parsed.choices[0],
                      delta: { content: "\n</think>\n\n" },
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(thinkEnd)}\n\n`);
              }
              if (delta.content !== undefined) {
                res.write(`data: ${JSON.stringify(parsed)}\n\n`);
              }
            }
          } catch (e) {
            // Skip unparseable lines
          }
        }
      });

      response.data.on("end", () => {
        res.end();
      });

      response.data.on("error", (err) => {
        console.error("Stream error:", err);
        res.end();
      });
    } else {
      // Non-streaming
      const result = response.data;
      if (!SHOW_REASONING) {
        // Strip reasoning from non-streaming response
        if (result.choices) {
          result.choices = result.choices.map((c) => {
            if (c.message?.reasoning_content) {
              delete c.message.reasoning_content;
            }
            return c;
          });
        }
      } else {
        // Wrap reasoning in think tags
        if (result.choices) {
          result.choices = result.choices.map((c) => {
            if (c.message?.reasoning_content) {
              c.message.content =
                `<think>\n${c.message.reasoning_content}\n</think>\n\n` +
                (c.message.content || "");
              delete c.message.reasoning_content;
            }
            return c;
          });
        }
      }
      res.json(result);
    }
  } catch (err) {
    const status = err.response?.status || 500;
    const message = err.response?.data || err.message;
    console.error("Proxy error:", status, message);
    res.status(status).json({ error: message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Show reasoning: ${SHOW_REASONING}`);
});
