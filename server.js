import express from 'express';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '.env'), override: false });
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.MODEL || 'gpt-5.5';
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 800);
const MAX_CONCURRENT_GENERATIONS = Math.max(1, Number(process.env.MAX_CONCURRENT_GENERATIONS || 3));
const dataRoot = process.env.APP_DATA_DIR || __dirname;
const imagesDir = process.env.APP_DATA_DIR ? join(dataRoot, 'images') : join(__dirname, 'public', 'images');
const dataDir = process.env.APP_DATA_DIR ? join(dataRoot, 'data') : join(__dirname, 'data');
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
});

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use('/images', express.static(imagesDir));
app.use(express.static(join(__dirname, 'public')));

// 确保目录存在
const dirs = [imagesDir, dataDir, join(dataRoot, 'logs')];
for (const dir of dirs) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const CONVERSATIONS_FILE = join(dataDir, 'conversations.json');

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
  const fullPath = process.env.APP_DATA_DIR ? join(imagesDir, filename) : join(__dirname, filename);
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

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms));
}

function isRetryableError(error) {
  if (error?.retryable === false) return false;
  const status = error?.status || error?.response?.status || error?.error?.status;
  if ([408, 409, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  const code = String(error?.code || error?.errno || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  return ['timeout', 'etimedout', 'econnreset', 'eai_again', 'enotfound'].some(key => code.includes(key) || message.includes(key));
}

async function withRetry(task, onRetry, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxRetries || !isRetryableError(error)) break;
      const delay = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
      await onRetry?.(attempt + 1, maxRetries, error, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

let activeGenerations = 0;
const generationQueue = [];

function sendSse(res, payload) {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }
}

function acquireGenerationSlot(res) {
  if (activeGenerations < MAX_CONCURRENT_GENERATIONS) {
    activeGenerations += 1;
    sendSse(res, { type: 'queued', active: activeGenerations, queue: generationQueue.length, max: MAX_CONCURRENT_GENERATIONS });
    return Promise.resolve();
  }

  sendSse(res, { type: 'queued', active: activeGenerations, queue: generationQueue.length + 1, max: MAX_CONCURRENT_GENERATIONS });
  return new Promise(resolveSlot => {
    generationQueue.push(() => {
      activeGenerations += 1;
      sendSse(res, { type: 'queued', active: activeGenerations, queue: generationQueue.length, max: MAX_CONCURRENT_GENERATIONS });
      resolveSlot();
    });
  });
}

function releaseGenerationSlot() {
  activeGenerations = Math.max(0, activeGenerations - 1);
  const next = generationQueue.shift();
  if (next) next();
}

async function createImageResponse(requestParams, res) {
  return withRetry(async (attempt) => {
    let imageBase64 = null;
    let revisedPrompt = null;
    let imageCallId = null;
    let responseId = null;
    let lastResponseSummary = null;

    sendSse(res, { type: 'attempt', attempt, maxRetries: MAX_RETRIES });

    try {
      const stream = await openai.responses.create(requestParams);
      for await (const event of stream) {
        console.log(`[Stream Event] type=${event.type}`);

        if (event.type === 'response.image_generation_call.partial_image') {
          sendSse(res, {
            type: 'partial_image',
            index: event.partial_image_index,
            data: event.partial_image_b64,
            attempt
          });
        } else if (event.type === 'response.output_item.done') {
          const imageCall = extractImageCall([event.item]);
          if (imageCall) {
            imageBase64 = imageCall.result;
            revisedPrompt = imageCall.revised_prompt;
            imageCallId = imageCall.id;
          }
        } else if (event.type === 'response.completed') {
          responseId = event.response?.id;
          lastResponseSummary = summarizeResponse(event.response);
          const imageCall = extractImageCall(event.response?.output);
          if (imageCall) {
            imageBase64 = imageCall.result;
            revisedPrompt = imageCall.revised_prompt;
            imageCallId = imageCall.id;
          }
        }
      }
    } catch (streamErr) {
      console.log(`[Stream failed] ${streamErr.message}, falling back to non-stream`);
    }

    if (!imageBase64) {
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
    }

    if (!imageBase64) {
      const detail = lastResponseSummary
        ? `未能生成图片。API 返回状态: ${lastResponseSummary.status || 'unknown'}，输出类型: ${lastResponseSummary.outputTypes.join(', ') || 'none'}${lastResponseSummary.text ? `，文本响应: ${lastResponseSummary.text}` : ''}`
        : '未能生成图片：API 未返回 image_generation_call.result';
      const err = new Error(detail);
      err.retryable = false;
      throw err;
    }

    return { imageBase64, revisedPrompt, imageCallId, responseId };
  }, async (nextAttempt, maxRetries, error, delay) => {
    console.warn(`[Retry] attempt ${nextAttempt}/${maxRetries} after ${delay}ms: ${error.message}`);
    sendSse(res, { type: 'retrying', attempt: nextAttempt, maxRetries, delayMs: delay, error: error.message });
  });
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

    await acquireGenerationSlot(res);

    let imageBase64 = null;
    let revisedPrompt = null;
    let imageCallId = null;
    let responseId = null;

    try {
      ({ imageBase64, revisedPrompt, imageCallId, responseId } = await createImageResponse(requestParams, res));
    } finally {
      releaseGenerationSlot();
    }

    console.log(`[Done] imageBase64=${!!imageBase64}, imageCallId=${imageCallId}`);

    // 保存最终图片
    if (imageBase64) {
      const timestamp = Date.now();
      const ext = outputFormat === 'jpeg' ? 'jpg' : (outputFormat || 'png');
      const imageName = `${conversation.id}_${timestamp}.${ext}`;
      const filename = process.env.APP_DATA_DIR ? imageName : `public/images/${imageName}`;
      saveImage(imageBase64, filename);

      const savedImageUrl = `/images/${imageName}`;

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
      sendSse(res, {
        type: 'completed',
        revisedPrompt,
        imageUrl: savedImageUrl,
        imageId: imageCallId,
        durationMs
      });
    }

    res.end();
  } catch (error) {
    console.error('Error generating image:', error);
    const errorMsg = error.error?.message || error.message || 'Unknown error';
    sendSse(res, { type: 'error', error: errorMsg, durationMs: Date.now() - startedAt });
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
export function startServer(port = PORT) {
  return new Promise((resolveServer, rejectServer) => {
    const server = app.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      server.actualPort = actualPort;
      console.log(`✅ Server running at http://127.0.0.1:${actualPort}`);
      console.log(`📡 API: OpenAI Responses API with ${MODEL}`);
      console.log(`🔑 Base URL: ${process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'}`);
      console.log(`🚦 Concurrent generations: ${MAX_CONCURRENT_GENERATIONS}, retries: ${MAX_RETRIES}`);
      resolveServer(server);
    });
    server.on('error', rejectServer);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
