import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
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
const dirs = ['public/images', 'logs', 'data'];
for (const dir of dirs) {
  const fullPath = join(__dirname, dir);
  if (!existsSync(fullPath)) {
    mkdirSync(fullPath, { recursive: true });
  }
}

const CONVERSATIONS_FILE = join(__dirname, 'data', 'conversations.json');

function loadConversations() {
  if (!existsSync(CONVERSATIONS_FILE)) return new Map();

  try {
    const raw = readFileSync(CONVERSATIONS_FILE, 'utf-8');
    if (!raw.trim()) return new Map();
    const list = JSON.parse(raw);
    return new Map(list.map(item => [item.id, item]));
  } catch (error) {
    console.error('[Conversations load failed]', error);
    return new Map();
  }
}

function saveConversations() {
  try {
    const list = Array.from(conversations.values());
    writeFileSync(CONVERSATIONS_FILE, JSON.stringify(list, null, 2));
  } catch (error) {
    console.error('[Conversations save failed]', error);
  }
}

// 存储对话历史
const conversations = loadConversations();

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

function normalizeImageSize(size) {
  if (!size || size === 'auto') return 'auto';
  if (/^\d+x\d+$/.test(size)) {
    const [w, h] = size.split('x').map(Number);
    const violations = [];
    if (w % 16 !== 0 || h % 16 !== 0) violations.push('边长必须是16的倍数');
    if (w > 3840 || h > 3840) violations.push('最大边长不能超过3840px');
    const maxSide = Math.max(w, h), minSide = Math.min(w, h);
    if (minSide > 0 && maxSide / minSide > 3) violations.push('长短边比例不能超过3:1');
    const totalPx = w * h;
    if (totalPx < 655360 || totalPx > 8294400) violations.push('总像素须在655360~8294400之间');
    if (violations.length > 0) {
      console.warn(`[Image size invalid] ${size}: ${violations.join('; ')}, falling back to 1024x1024`);
      return '1024x1024';
    }
    return size;
  }

  const ratioMap = {
    '1:1': '1024x1024',
    '2:3': '1024x1536',
    '3:2': '1536x1024',
  };
  return ratioMap[size] || '1024x1024';
}

function extractImageCall(output = []) {
  return output.find(item => item?.type === 'image_generation_call' && item?.result)
    || output.flatMap(item => item?.content || []).find(item => item?.type === 'image_generation_call' && item?.result)
    || null;
}

function redactInlineImages(text = '') {
  return text.replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g, '[已隐藏内联图片数据]');
}

function summarizeResponse(response) {
  const output = response?.output || [];
  const outputTypes = output.map(item => item?.type).filter(Boolean);
  const text = redactInlineImages(output
    .flatMap(item => item?.content || [])
    .map(item => item?.text || item?.content || '')
    .filter(Boolean)
    .join('\n'))
    .slice(0, 500);

  return {
    status: response?.status,
    outputTypes,
    text,
  };
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
    lastResponseId: null,
    lastImageCallId: null,
    title: '新对话',
    createdAt: new Date().toISOString()
  });
  saveConversations();
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
  saveConversations();
  res.json({ success: true });
});

// 生成图片 - 流式响应 (支持生成和编辑)
app.post('/api/generate', async (req, res) => {
  const startedAt = Date.now();

  const {
    conversationId,
    prompt,
    action = 'auto',
    quality = 'medium',
    size = '1024x1024',
    imageUrl,
    imageUrls = [],
    outputFormat,
    outputCompression,
    moderation,
    background,
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
      lastResponseId: null,
      lastImageCallId: null,
      title: '新对话',
      createdAt: new Date().toISOString()
    };
    conversations.set(id, conversation);
    saveConversations();
    console.log(`[Auto-create conversation] id=${id}`);
  }

  // 设置 SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const referenceImageUrls = Array.isArray(imageUrls) && imageUrls.length > 0
      ? imageUrls
      : (imageUrl ? [imageUrl] : []);

    let input;
    let previousResponseId = undefined;

    if (referenceImageUrls.length > 0) {
      input = [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: `请直接基于${referenceImageUrls.length}张参考图片编辑并生成一张新图片。最终输出必须是图片，不要返回文字说明、操作建议、代码块或提示词文本。编辑要求：${prompt}` },
            ...referenceImageUrls.map(url => ({ type: 'input_image', image_url: url }))
          ]
        }
      ];
    } else if (conversation.lastResponseId) {
      previousResponseId = conversation.lastResponseId;
      input = prompt;
    } else {
      input = prompt;
    }

    const toolConfig = {
      type: 'image_generation',
      action,
      quality,
      size: normalizeImageSize(size),
      partial_images: 2,
    };
    if (outputFormat && outputFormat !== 'png') {
      toolConfig.output_format = outputFormat;
    }
    if (outputCompression != null && (outputFormat === 'jpeg' || outputFormat === 'webp')) {
      toolConfig.output_compression = outputCompression;
    }
if (moderation && moderation !== 'auto') {
    toolConfig.moderation = moderation;
  }
  if (background && background !== 'auto') {
    toolConfig.background = background;
  }

    const requestParams = {
      model: MODEL,
      input,
      previous_response_id: previousResponseId,
      tools: [toolConfig],
      stream: true
    };

    let imageBase64 = null;
    let revisedPrompt = null;
    let imageCallId = null;
    let responseId = null;

    let useStream = true;
    let lastResponseSummary = null;

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
            const imageCall = extractImageCall([item]);
            if (imageCall) {
              imageBase64 = imageCall.result;
              revisedPrompt = imageCall.revised_prompt;
              imageCallId = imageCall.id;
            }
          } else if (event.type === 'response.completed') {
            responseId = event.response?.id;
            lastResponseSummary = summarizeResponse(event.response);
            console.log(`[response.completed] id=${responseId}`, lastResponseSummary);
            if (!imageBase64) {
              const imageCall = extractImageCall(event.response?.output);
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
        const nonStreamTool = { ...requestParams.tools[0] };
        delete nonStreamTool.partial_images;
        const nonStreamParams = { ...requestParams, tools: [nonStreamTool], stream: false };
        const nonStreamResponse = await openai.responses.create(nonStreamParams);
        lastResponseSummary = summarizeResponse(nonStreamResponse);
        console.log(`[Non-stream response]`, lastResponseSummary);

        const imageCall = extractImageCall(nonStreamResponse.output);
        if (imageCall) {
          imageBase64 = imageCall.result;
          revisedPrompt = imageCall.revised_prompt;
          imageCallId = imageCall.id;
          responseId = nonStreamResponse.id;
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
      const ext = outputFormat === 'jpeg' ? 'jpg' : (outputFormat || 'png');
      const filename = `public/images/${conversationId}_${timestamp}.${ext}`;
      saveImage(imageBase64, filename);

      const savedImageUrl = `/images/${conversationId}_${timestamp}.${ext}`;

      // 更新对话历史
      const userMessage = {
        role: 'user',
        content: prompt,
        imageUrls: referenceImageUrls.length > 0 ? referenceImageUrls : undefined,
        imageUrl: referenceImageUrls[0]
      };
      const durationMs = Date.now() - startedAt;
      const assistantMessage = {
        role: 'assistant',
        content: revisedPrompt || prompt,
        imageUrl: savedImageUrl,
        imageId: imageCallId,
        durationMs
      };

    conversation.messages.push(userMessage, assistantMessage);

    conversation.lastImageBase64 = imageBase64;
    conversation.lastResponseId = responseId;
    conversation.lastImageCallId = imageCallId;

      // 更新对话标题（取用户第一条消息前20字）
      if (conversation.messages.length <= 2) {
        conversation.title = prompt.slice(0, 20) + (prompt.length > 20 ? '...' : '');
      }

      saveConversations();

      // 发送完成事件
      res.write(`data: ${JSON.stringify({
        type: 'completed',
        revisedPrompt,
        imageUrl: savedImageUrl,
        imageId: imageCallId,
        durationMs
      })}\n\n`);
    } else {
      const detail = lastResponseSummary
        ? `未能生成图片。API 返回状态: ${lastResponseSummary.status || 'unknown'}，输出类型: ${lastResponseSummary.outputTypes.join(', ') || 'none'}${lastResponseSummary.text ? `，文本响应: ${lastResponseSummary.text}` : ''}`
        : '未能生成图片：API 未返回 image_generation_call.result';
      res.write(`data: ${JSON.stringify({ type: 'error', error: detail, durationMs: Date.now() - startedAt })}\n\n`);
    }

    res.end();
  } catch (error) {
    console.error('Error generating image:', error);
    const errorMsg = error.error?.message || error.message || 'Unknown error';
    res.write(`data: ${JSON.stringify({ type: 'error', error: errorMsg, durationMs: Date.now() - startedAt })}\n\n`);
    res.end();
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
