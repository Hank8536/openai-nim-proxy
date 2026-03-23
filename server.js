const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔐 Set your own secret (used by JanitorAI)
const PROXY_API_KEY = process.env.PROXY_API_KEY || "my-secret-key";

// NVIDIA API config
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Middleware
app.use(cors());
app.use(express.json());

// 🔐 Simple API key protection
app.use((req, res, next) => {
  const key = req.headers['authorization'];
  if (!key || key !== `Bearer ${PROXY_API_KEY}`) {
    return res.status(401).json({
      error: { message: "Unauthorized" }
    });
  }
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NIM Proxy (Node.js)'
  });
});

// Chat endpoint (OpenAI-compatible)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    if (!model) {
      return res.status(400).json({
        error: { message: "Model is required" }
      });
    }

    const response = await axios.post(
      `${NIM_API_BASE}/chat/completions`,
      {
        model: model,
        messages: messages,
        temperature: temperature || 0.6,
        max_tokens: max_tokens || 2048,
        stream: stream || false
      },
      {
        headers: {
          'Authorization': `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: stream ? 'stream' : 'json'
      }
    );

    if (stream) {
      // Stream response directly
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.data.pipe(res);
    } else {
      // Normal response
      res.json(response.data);
    }

  } catch (error) {
    console.error("Error:", error.message);

    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data || error.message
      }
    });
  }
});

// Optional models endpoint
app.get('/v1/models', (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "meta/llama-3.1-8b-instruct" },
      { id: "meta/llama-3.1-70b-instruct" },
      { id: "deepseek-ai/deepseek-v3.1" }
    ]
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: { message: "Endpoint not found" }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on http://localhost:${PORT}`);
});
