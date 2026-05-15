import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { createReadStream, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.MODEL || 'gpt-5.5';
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(join(__dirname, 'public')));

// 确保目录存在
const dirs = ['public/images', 'public/temp', 'logs'];
for (const dir of dirs) {
  const fullPath = join(__dirname, dir);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
  }
}

// 存储对话历史
const conversations = new Map();

// 生成唯一ID
function generateId() {
  return uuidv4();
}

// 保存图片到文件
function saveImage(base64Data, filename) {
  const fullPath = join(__dirname, filename);
  const buffer = Buffer.from(base64Data, 'base64');
  writeFileSync(fullPath, buffer);
  return filename;
}

// 首页路由
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// 创建新对话
app.post('/api/conversations', (req, res) => {
  const id = generateId();
  conversations.set(id, {
    id,
    messages: [],
    lastImageBase64: null,
    title: '新对话',
    createdAt: new Date().toISOString()
  });
  res.json({ id });
});

// 获取对话历史
app.get('/api/conversations/:id', (req, res) => {
  const conversation = conversations.get(req.params.id);
  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }
  res.json(conversation);
});

// 删除对话
app.delete('/api/conversations/:id', (req, res) => {
  conversations.delete(req.params.id);
  res.json({ success: true });
});

// 生成图片 - 流式响应 (支持生成和编辑)
app.post('/api/generate', async (req, res) => {
  const {
    conversationId,
    prompt,
    action = 'auto',
    quality = 'medium',
    size = '1024x1024',
    imageUrl,
  } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required' });
  }

  let conversation = conversations.get(conversationId);

  // 如果对话不存在，自动创建
  if (!conversation) {
    const id = conversationId || generateId();
    conversation = {
      id,
      messages: [],
      lastImageBase64: null,
      title: '新对话',
      createdAt: new Date().toISOString()
    };
    conversations.set(id, conversation);
    console.log(`[Auto-create conversation] id=${id}`);
  }

  // 设置 SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    // 构建 input：多轮对话时用 base64 传入上一轮图片
    let input;
    if (conversation.lastImageBase64 && !fileId) {
      // 多轮编辑：带上之前生成的图片(base64 内联)
      input = [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            {
              type: 'input_image',
              image_url: `data:image/png;base64,${conversation.lastImageBase64}`
            }
          ]
        }
      ];
    } else if (imageUrl) {
      // 上传图片编辑（base64 data URL 内联）
      input = [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: imageUrl }
          ]
        }
      ];
    } else {
      // 首次生成
      input = prompt;
    }

    const requestParams = {
      model: MODEL,
      input,
      tools: [{
        type: 'image_generation',
        action,
        quality,
        size
      }],
      stream: true
    };

    let imageBase64 = null;
    let revisedPrompt = null;
    let imageCallId = null;
    let responseId = null;

    let useStream = true;

    try {
      const stream = await openai.responses.create(requestParams);

        for await (const event of stream) {
          console.log(`[Stream Event] type=${event.type}`);

          if (event.type === 'response.image_generation_call.partial_image') {
            res.write(`data: ${JSON.stringify({
              type: 'partial_image',
              index: event.partial_image_index,
              data: event.partial_image_b64
            })}\n\n`);
          } else if (event.type === 'response.output_item.done') {
            const item = event.item;
            console.log(`[output_item.done] item.type=${item?.type}`);
            if (item && item.type === 'image_generation_call') {
              imageBase64 = item.result;
              revisedPrompt = item.revised_prompt;
              imageCallId = item.id;
            }
          } else if (event.type === 'response.completed') {
            responseId = event.response?.id;
            console.log(`[response.completed] id=${responseId}`);
            if (!imageBase64) {
              const imageCall = event.response?.output?.find(o => o.type === 'image_generation_call');
              if (imageCall) {
                imageBase64 = imageCall.result;
                revisedPrompt = imageCall.revised_prompt;
                imageCallId = imageCall.id;
              }
            }
          }
        }
    } catch (streamErr) {
      console.log(`[Stream failed] ${streamErr.message}, falling back to non-stream`);
      useStream = false;
    }

    // 非流式 fallback
    if (!useStream || !imageBase64) {
      try {
        const nonStreamParams = { ...requestParams, stream: false };
        response = await openai.responses.create(nonStreamParams);
        console.log(`[Non-stream response] status=${response.status}, output:`, response.output?.map(o => o.type));

        const imageCall = response.output?.find(o => o.type === 'image_generation_call');
        if (imageCall) {
          imageBase64 = imageCall.result;
          revisedPrompt = imageCall.revised_prompt;
          imageCallId = imageCall.id;
          responseId = response.id;
        }
      } catch (nonStreamErr) {
        console.error('[Non-stream also failed]', nonStreamErr);
        throw nonStreamErr;
      }
    }

    console.log(`[Done] imageBase64=${!!imageBase64}, imageCallId=${imageCallId}`);

    // 保存最终图片
    if (imageBase64) {
      const timestamp = Date.now();
      const filename = `public/images/${conversationId}_${timestamp}.png`;
      saveImage(imageBase64, filename);

      const imageUrl = `/images/${conversationId}_${timestamp}.png`;

      // 更新对话历史
      const userMessage = { role: 'user', content: prompt };
      const assistantMessage = {
        role: 'assistant',
        content: revisedPrompt || prompt,
        imageUrl,
        imageId: imageCallId
      };

      conversation.messages.push(userMessage, assistantMessage);

      conversation.lastImageBase64 = imageBase64;

      // 更新对话标题（取用户第一条消息前20字）
      if (conversation.messages.length <= 2) {
        conversation.title = prompt.slice(0, 20) + (prompt.length > 20 ? '...' : '');
      }

      // 发送完成事件
      res.write(`data: ${JSON.stringify({
        type: 'completed',
        revisedPrompt,
        imageUrl,
        imageId: imageCallId
      })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: 'error', error: '未能生成图片' })}\n\n`);
    }

    res.end();
  } catch (error) {
    console.error('Error generating image:', error);
    const errorMsg = error.error?.message || error.message || 'Unknown error';
    res.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg })}\n\n`);
    res.end();
  }
});

// 上传图片用于编辑
app.post('/api/upload', async (req, res) => {
  const { imageData, conversationId } = req.body;

  if (!imageData) {
    return res.status(400).json({ error: 'Image data is required' });
  }

  try {
    const buffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    const tempFilename = `public/temp/${conversationId || 'upload'}_${Date.now()}.png`;
    const tempPath = join(__dirname, tempFilename);

    writeFileSync(tempPath, buffer);

    // 上传到 OpenAI Files API
    const file = await openai.files.create({
      file: createReadStream(tempPath),
      purpose: 'vision',
    });

    // 清理临时文件
    try { unlinkSync(tempPath); } catch {}

    res.json({ fileId: file.id });
  } catch (error) {
    console.error('Error uploading image:', error);
    res.status(500).json({ error: error.message });
  }
});

// 获取对话列表
app.get('/api/conversations', (req, res) => {
  const list = Array.from(conversations.values()).map(c => ({
    id: c.id,
    title: c.title,
    messages: c.messages.length,
    createdAt: c.createdAt
  }));
  res.json(list);
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📡 API: OpenAI Responses API with ${MODEL}`);
  console.log(`🔑 Base URL: ${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}`);
});
