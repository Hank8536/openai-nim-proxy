// server.js - OpenAI → NVIDIA NIM API Proxy (No Model Mapping)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 Toggles
const SHOW_REASONING = false;        // Show <think> blocks
const ENABLE_THINKING_MODE = false;  // Enable "thinking" parameter

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI → NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (static dummy response)
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: "dynamic-models",
      object: "model",
      created: Date.now(),
      owned_by: "nvidia-nim-proxy"
    }]
  });
});

// Chat completions endpoint
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    if (!model) {
      return res.status(400).json({
        error: { message: "Model is required.", type: "invalid_request_error" }
      });
    }

    // Always pass the exact model name from the client
    const nimModel = model;

    // Build request body for NVIDIA NIM
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature ?? 0.6,
      max_tokens: max_tokens ?? 2048,
      stream: stream ?? false,
      extra_body: ENABLE_THINKING_MODE
        ? { chat_template_kwargs: { thinking: true } }
        : undefined
    };

    // Send request to NVIDIA NIM
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    // === STREAMING RESPONSE SUPPORT ===
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          if (line.includes('[DONE]')) {
            res.write(line + '\n\n');
            continue;
          }

          try {
            const data = JSON.parse(line.slice(6));

            if (data.choices?.[0]?.delta) {
              const delta = data.choices[0].delta;
              const reasoning = delta.reasoning_content;
              const content = delta.content;

              if (SHOW_REASONING) {
                let combined = '';

                if (reasoning && !reasoningStarted) {
                  combined = '<think>\n' + reasoning;
                  reasoningStarted = true;
                } else if (reasoning) {
                  combined = reasoning;
                }

                if (content && reasoningStarted) {
                  combined += '</think>\n\n' + content;
                  reasoningStarted = false;
                } else if (content) {
                  combined += content;
                }

                delta.content = combined || '';
                delete delta.reasoning_content;
              } else {
                delta.content = content || '';
                delete delta.reasoning_content;
              }
            }

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (err) {
            res.write(line + '\n\n');
          }
        }
      });

      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
      return;
    }

    // === NON-STREAMING RESPONSE ===
    const openaiResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: response.data.choices.map(choice => {
        let content = choice.message?.content || '';

        if (SHOW_REASONING && choice.message?.reasoning_content) {
          content =
            `<think>\n${choice.message.reasoning_content}\n</think>\n\n` +
            content;
        }

        return {
          index: choice.index,
          message: { role: choice.message.role, content },
          finish_reason: choice.finish_reason
        };
      }),
      usage: response.data.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    res.json(openaiResponse);

  } catch (error) {
    console.error('Proxy error:', error.message);

    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.error?.message || error.message,
        type: 'api_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Fallback for unknown routes
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning: ${SHOW_REASONING ? 'ON' : 'OFF'}`);
  console.log(`Thinking: ${ENABLE_THINKING_MODE ? 'ON' : 'OFF'}`);
});
