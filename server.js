// server.js - OpenAI → NVIDIA NIM passthrough proxy (no model mapping)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// NVIDIA config
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// Toggles
const SHOW_REASONING = false;
const ENABLE_THINKING_MODE = false;

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'OpenAI → NVIDIA NIM Proxy',
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// Return the model name directly (no mapping)
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: "USE_NVIDIA_MODEL_NAMES_DIRECTLY",
        object: 'model',
        created: Date.now(),
        owned_by: 'nvidia-nim-proxy'
      }
    ]
  });
});

// Chat completions (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;

    // Do NOT modify model name. Use it EXACTLY as provided.
    const nimRequest = {
      model: model,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 4096,
      extra_body: ENABLE_THINKING_MODE ? { chat_template_kwargs: { thinking: true } } : undefined,
      stream: stream || false
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });

    // STREAM MODE
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

        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\n');
              return;
            }

            try {
              const data = JSON.parse(line.slice(6));

              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;

                if (!SHOW_REASONING) {
                  delete data.choices[0].delta.reasoning_content;
                } else {
                  let out = '';
                  if (reasoning && !reasoningStarted) {
                    out = `<think>\n${reasoning}`;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    out = reasoning;
                  }

                  if (content && reasoningStarted) {
                    out += `</think>\n\n${content}`;
                    reasoningStarted = false;
                  } else if (content) {
                    out += content;
                  }

                  data.choices[0].delta.content = out;
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) {
              res.write(line + '\n');
            }
          }
        });
      });

      response.data.on('end', () => res.end());
      response.data.on('error', () => res.end());
      return;
    }

    // NORMAL MODE
    const openaiResponse = {
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: response.data.choices.map(choice => {
        let content = choice.message?.content || '';

        if (SHOW_REASONING && choice.message?.reasoning_content) {
          content =
            `<think>\n${choice.message.reasoning_content}\n</think>\n\n${content}`;
        }

        return {
          index: choice.index,
          message: {
            role: choice.message.role,
            content
          },
          finish_reason: choice.finish_reason
        };
      }),
      usage: response.data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };

    res.json(openaiResponse);

  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message,
        type: 'nim_api_error',
        code: error.response?.status || 500
      }
    });
  }
});

// 404 fallback
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`NIM Proxy running on port ${PORT}`);
});
