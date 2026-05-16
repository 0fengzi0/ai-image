# OpenAI 图片生成 API 知识库

> 基于 OpenAI 官方文档整理，更新时间：2026-05  
> 文档来源：https://developers.openai.com/api/docs/guides/image-generation

---

## 目录

1. [概述](#1-概述)
2. [两种 API 对比](#2-两种-api-对比)
3. [生成图片](#3-生成图片)
4. [多轮图片生成](#4-多轮图片生成)
5. [流式输出](#5-流式输出)
6. [修订提示词（Revised Prompt）](#6-修订提示词revised-prompt)
7. [编辑图片](#7-编辑图片)
8. [图片输入保真度](#8-图片输入保真度)
9. [自定义图片输出](#9-自定义图片输出)
10. [限制与注意事项](#10-限制与注意事项)
11. [内容审核](#11-内容审核)
12. [支持的模型](#12-支持的模型)
13. [成本与延迟](#13-成本与延迟)
14. [API 端点速查](#14-api-端点速查)

---

## 1. 概述

OpenAI API 允许通过文本提示词使用 GPT Image 模型（包括最新的 `gpt-image-2`）生成和编辑图片。

**重要前置条件：** 使用 GPT Image 模型（gpt-image-2、gpt-image-1.5、gpt-image-1、gpt-image-1-mini）前，需在开发者控制台完成 **API Organization Verification**（组织验证）。

---

## 2. 两种 API 对比

| 特性 | Image API | Responses API |
|------|-----------|---------------|
| **适用场景** | 单次生成/编辑图片 | 对话式、多步流程的图片体验 |
| **端点** | `/v1/images/generations`（生成）、`/v1/images/edits`（编辑） | `/v1/responses` |
| **多轮编辑** | 不支持 | 支持，可迭代编辑 |
| **图片输入方式** | 字节流/文件 | 支持 File ID、Base64 Data URL、URL |
| **对话上下文** | 无 | 支持 `previous_response_id` |
| **模型** | `gpt-image-2` 等 GPT Image 模型 | 主线模型（如 `gpt-5.5`）+ `image_generation` 工具 |

**选择建议：**
- 只需从单个提示词生成/编辑一张图片 → **Image API**
- 构建对话式、可迭代编辑的图片体验 → **Responses API**

---

## 3. 生成图片

### 3.1 Image API — 生成图片

**端点：** `POST /v1/images/generations`

```python
from openai import OpenAI
import base64

client = OpenAI()

result = client.images.generate(
    model="gpt-image-2",
    prompt="A children's book drawing of a veterinarian using a stethoscope to listen to the heartbeat of a baby otter."
)

image_base64 = result.data[0].b64_json
image_bytes = base64.b64decode(image_base64)

with open("otter.png", "wb") as f:
    f.write(image_bytes)
```

```javascript
import OpenAI from "openai";
import fs from "fs";

const openai = new OpenAI();

const result = await openai.images.generate({
    model: "gpt-image-2",
    prompt: "A children's book drawing of a veterinarian using a stethoscope to listen to the heartbeat of a baby otter.",
});

const image_base64 = result.data[0].b64_json;
const image_bytes = Buffer.from(image_base64, "base64");
fs.writeFileSync("otter.png", image_bytes);
```

**cURL：**
```bash
curl -X POST "https://api.openai.com/v1/images/generations" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -H "Content-type: application/json" \
    -d '{
        "model": "gpt-image-2",
        "prompt": "A childrens book drawing of a veterinarian using a stethoscope to listen to the heartbeat of a baby otter."
    }' | jq -r '.data[0].b64_json' | base64 --decode > otter.png
```

**参数 `n`：** 可设置一次请求生成多张图片（默认返回 1 张）。

### 3.2 Responses API — 生成图片

```python
from openai import OpenAI
import base64

client = OpenAI()

response = client.responses.create(
    model="gpt-5.5",
    input="Generate an image of gray tabby cat hugging an otter with an orange scarf",
    tools=[{"type": "image_generation"}],
)

image_data = [
    output.result
    for output in response.output
    if output.type == "image_generation_call"
]

if image_data:
    image_base64 = image_data[0]
    with open("otter.png", "wb") as f:
        f.write(base64.b64decode(image_base64))
```

```javascript
import OpenAI from "openai";
const openai = new OpenAI();

const response = await openai.responses.create({
    model: "gpt-5.5",
    input: "Generate an image of gray tabby cat hugging an otter with an orange scarf",
    tools: [{type: "image_generation"}],
});

const imageData = response.output
  .filter((output) => output.type === "image_generation_call")
  .map((output) => output.result);

if (imageData.length > 0) {
    const imageBase64 = imageData[0];
    const fs = await import("fs");
    fs.writeFileSync("otter.png", Buffer.from(imageBase64, "base64"));
}
```

**响应中提取图片：** 过滤 `output.type === "image_generation_call"`，取 `output.result`（Base64 编码的图片数据）。

---

## 4. 多轮图片生成

仅 **Responses API** 支持多轮图片生成，有两种方式：

### 4.1 使用 `previous_response_id`

将上一轮响应的 ID 传入下一轮请求，自动继承上下文：

```python
# 第一轮
response = client.responses.create(
    model="gpt-5.5",
    input="Generate an image of gray tabby cat hugging an otter with an orange scarf",
    tools=[{"type": "image_generation"}],
)

# 第二轮 - 继承上下文
response_fwup = client.responses.create(
    model="gpt-5.5",
    previous_response_id=response.id,
    input="Now make it look realistic",
    tools=[{"type": "image_generation"}],
)
```

### 4.2 使用图片 ID

在 `input` 中直接引用上一次的图片生成调用 ID：

```python
response_fwup = client.responses.create(
    model="gpt-5.5",
    input=[
        {
            "role": "user",
            "content": [{"type": "input_text", "text": "Now make it look realistic"}],
        },
        {
            "type": "image_generation_call",
            "id": image_generation_calls[0].id,  # 上一轮的生成调用 ID
        },
    ],
    tools=[{"type": "image_generation"}],
)
```

### 4.3 `action` 参数控制行为

| action 值 | 行为 |
|-----------|------|
| `auto`（默认） | 模型自动决定生成新图还是编辑现有图 |
| `generate` | 强制生成新图片 |
| `edit` | 强制编辑上下文中的图片（无图片时返回错误） |

```python
tools=[{"type": "image_generation", "action": "generate"}]  # 强制生成
tools=[{"type": "image_generation", "action": "edit"}]      # 强制编辑
```

---

## 5. 流式输出

两种 API 均支持流式图片生成，通过 `partial_images` 参数控制接收中间图片数量（0-3）。

- `partial_images: 0` → 只接收最终图片
- `partial_images: 1-3` → 接收对应数量的中间图片（可能少于请求数，如果最终图片更快生成完成）

### 5.1 Image API 流式

```python
stream = client.images.generate(
    prompt="Draw a gorgeous image of a river made of white owl feathers...",
    model="gpt-image-2",
    stream=True,
    partial_images=2,
)

for event in stream:
    if event.type == "image_generation.partial_image":
        idx = event.partial_image_index
        image_base64 = event.b64_json
        image_bytes = base64.b64decode(image_base64)
        with open(f"river{idx}.png", "wb") as f:
            f.write(image_bytes)
```

### 5.2 Responses API 流式

```python
stream = client.responses.create(
    model="gpt-5.5",
    input="Draw a gorgeous image of a river made of white owl feathers...",
    stream=True,
    tools=[{"type": "image_generation", "partial_images": 2}],
)

for event in stream:
    if event.type == "response.image_generation_call.partial_image":
        idx = event.partial_image_index
        image_base64 = event.partial_image_b64
        image_bytes = base64.b64decode(image_base64)
        with open(f"river{idx}.png", "wb") as f:
            f.write(image_bytes)
```

**事件类型区别：**
| API | 事件类型 |
|-----|---------|
| Image API | `image_generation.partial_image` |
| Responses API | `response.image_generation_call.partial_image` |

**流式费用：** 每个中间图片（partial image）额外产生 **100 个图片输出 token**。

---

## 6. 修订提示词（Revised Prompt）

使用 Responses API 时，主线模型（如 gpt-5.5）会自动修订提示词以提升效果。

修订后的提示词可在响应的 `revised_prompt` 字段中获取：

```json
{
  "id": "ig_123",
  "type": "image_generation_call",
  "status": "completed",
  "revised_prompt": "A gray tabby cat hugging an otter. The otter is wearing an orange scarf. Both animals are cute and friendly, depicted in a warm, heartwarming style.",
  "result": "..."
}
```

---

## 7. 编辑图片

### 7.1 使用图片参考生成新图

Image API 的 `/v1/images/edits` 端点支持传入多张参考图片生成新图。

**Image API：**

```python
result = client.images.edit(
    model="gpt-image-2",
    image=[
        open("body-lotion.png", "rb"),
        open("bath-bomb.png", "rb"),
        open("incense-kit.png", "rb"),
        open("soap.png", "rb"),
    ],
    prompt="Generate a photorealistic image of a gift basket on a white background labeled 'Relax & Unwind'..."
)
```

**cURL：**
```bash
curl -X POST "https://api.openai.com/v1/images/edits" \
    -H "Authorization: Bearer $OPENAI_API_KEY" \
    -F "model=gpt-image-2" \
    -F "image[]=@body-lotion.png" \
    -F "image[]=@bath-bomb.png" \
    -F "image[]=@incense-kit.png" \
    -F "image[]=@soap.png" \
    -F 'prompt=Generate a photorealistic image of a gift basket...'
```

**Responses API — 三种图片输入方式：**

| 输入方式 | 说明 |
|---------|------|
| URL | 提供完整图片 URL |
| Base64 Data URL | `data:image/jpeg;base64,{base64_string}` |
| File ID | 通过 Files API 上传后获取的 ID |

```python
# 创建文件
def create_file(file_path):
    with open(file_path, "rb") as file_content:
        result = client.files.create(file=file_content, purpose="vision")
        return result.id

# Base64 编码
def encode_image(file_path):
    with open(file_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")

# 使用三种方式混合输入
response = client.responses.create(
    model="gpt-5.5",
    input=[{
        "role": "user",
        "content": [
            {"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": f"data:image/jpeg;base64,{base64_image1}"},
            {"type": "input_image", "image_url": f"data:image/jpeg;base64,{base64_image2}"},
            {"type": "input_image", "file_id": file_id1},
            {"type": "input_image", "file_id": file_id2},
        ],
    }],
    tools=[{"type": "image_generation"}],
)
```

### 7.2 使用 Mask 编辑图片

通过 Mask 指定图片中需要编辑的区域。

**关键说明：**
- Mask 编辑是基于提示词的，模型将 Mask 作为指导但可能不完全遵循其精确形状
- 如果提供多张输入图片，Mask 应用于第一张图片

**Image API：**

```python
result = client.images.edit(
    model="gpt-image-2",
    image=open("sunlit_lounge.png", "rb"),
    mask=open("mask.png", "rb"),
    prompt="A sunlit indoor lounge area with a pool containing a flamingo"
)
```

**Responses API：**

```python
fileId = create_file("sunlit_lounge.png")
maskId = create_file("mask.png")

response = client.responses.create(
    model="gpt-5.5",
    input=[{
        "role": "user",
        "content": [
            {"type": "input_text", "text": "generate an image of the same sunlit indoor lounge area with a pool but the pool should contain a flamingo"},
            {"type": "input_image", "file_id": fileId},
        ],
    }],
    tools=[{
        "type": "image_generation",
        "quality": "high",
        "input_image_mask": {"file_id": maskId},
    }],
)
```

### 7.3 Mask 要求

| 要求 | 说明 |
|------|------|
| 格式与尺寸 | 编辑图片和 Mask 必须相同格式和尺寸 |
| 文件大小 | 小于 50MB |
| Alpha 通道 | Mask 图片必须包含 Alpha 通道 |

**为黑白 Mask 添加 Alpha 通道：**

```python
from PIL import Image
from io import BytesIO

# 1. 加载灰度 Mask
mask = Image.open(img_path_mask).convert("L")
# 2. 转换为 RGBA
mask_rgba = mask.convert("RGBA")
# 3. 用 Mask 本身填充 Alpha 通道
mask_rgba.putalpha(mask)
# 4. 保存
buf = BytesIO()
mask_rgba.save(buf, format="PNG")
with open("mask_alpha.png", "wb") as f:
    f.write(buf.getvalue())
```

---

## 8. 图片输入保真度

`input_fidelity` 参数控制模型在编辑和参考图片工作流中保留输入图片细节的程度。

- **gpt-image-2**：不可设置此参数，模型自动以高保真度处理每张输入图片
- 由于 gpt-image-2 始终高保真处理，包含参考图片的编辑请求可能产生更多输入 token

---

## 9. 自定义图片输出

### 9.1 可配置项

| 参数 | 说明 | 可选值 |
|------|------|--------|
| `size` | 图片尺寸 | 具体尺寸或 `auto`（默认） |
| `quality` | 渲染质量 | `low`、`medium`、`high`、`auto`（默认） |
| `output_format` | 输出格式 | `png`（默认）、`jpeg`、`webp` |
| `output_compression` | 压缩级别 | 0-100%（仅 jpeg/webp） |
| `background` | 背景透明度 | `opaque`、`transparent`（自动）、`auto`（默认） |

> **注意：** `gpt-image-2` 当前**不支持**透明背景（`background: "transparent"`）。

### 9.2 尺寸规格

**常用尺寸：**

| 尺寸 | 类型 |
|------|------|
| `1024x1024` | 方形 |
| `1536x1024` | 横向 |
| `1024x1536` | 纵向 |
| `2048x2048` | 2K 方形 |
| `2048x1152` | 2K 横向 |
| `3840x2160` | 4K 横向 |
| `2160x3840` | 4K 纵向 |
| `auto` | 默认，模型自动选择 |

**尺寸约束（gpt-image-2）：**

| 约束 | 值 |
|------|-----|
| 最大边长 | ≤ 3840px |
| 边长对齐 | 必须为 16 的倍数 |
| 长短边比 | 不超过 3:1 |
| 总像素范围 | 655,360 ~ 8,294,400 |

### 9.3 质量选项

| 质量 | 适用场景 |
|------|---------|
| `low` | 快速草稿、缩略图、快速迭代 |
| `medium` | 一般用途 |
| `high` | 最终产出 |

> 超过 2560×1440（3,686,400 总像素）的输出被视为实验性功能。

### 9.4 输出格式

- **默认：** `png`
- **推荐低延迟：** 使用 `jpeg`（比 png 更快）
- `webp` 同样支持
- 使用 `jpeg`/`webp` 时可设置 `output_compression`（0-100%）

---

## 10. 限制与注意事项

| 限制 | 说明 |
|------|------|
| **延迟** | 复杂提示词可能需要最多 2 分钟处理 |
| **文字渲染** | 虽有显著改善，精确文字放置和清晰度仍可能不稳定 |
| **一致性** | 跨多次生成中，重复角色或品牌元素的视觉一致性可能不够稳定 |
| **构图控制** | 结构化或布局敏感的构图中，精确放置元素仍有困难 |

---

## 11. 内容审核

所有提示词和生成图片均按内容策略过滤。

`moderation` 参数控制审核严格度：

| 值 | 说明 |
|----|------|
| `auto`（默认） | 标准过滤，限制生成某些可能不适合未成年人的内容 |
| `low` | 较宽松的过滤 |

---

## 12. 支持的模型

### Image API 模型

| 模型 | 说明 |
|------|------|
| `gpt-image-2` | 最新模型，支持任意分辨率（符合约束） |
| `gpt-image-1.5` | 早期模型 |
| `gpt-image-1` | 早期模型 |
| `gpt-image-1-mini` | 轻量模型 |

### Responses API 模型

使用 `image_generation` 工具时，`gpt-5` 及更新模型应支持此工具。需查看具体模型详情页确认。

---

## 13. 成本与延迟

### 13.1 gpt-image-2 输出 Token

gpt-image-2 的输出 token 根据请求的质量和尺寸计算（使用官方计算器估算）。

### 13.2 gpt-image-2 之前模型的 Token 消耗

| 质量 | 方形 (1024×1024) | 纵向 (1024×1536) | 横向 (1536×1024) |
|------|-------------------|-------------------|-------------------|
| Low | 272 tokens | 408 tokens | 400 tokens |
| Medium | 1056 tokens | 1584 tokens | 1568 tokens |
| High | 4160 tokens | 6240 tokens | 6208 tokens |

### 13.3 价格参考

| 模型 | 质量 | 1024×1024 | 1024×1536 | 1536×1024 |
|------|------|-----------|-----------|-----------|
| **GPT Image 2** | Low | $0.006 | $0.005 | $0.005 |
| | Medium | $0.053 | $0.041 | $0.041 |
| | High | $0.211 | $0.165 | $0.165 |
| **GPT Image 1.5** | Low | $0.009 | $0.013 | $0.013 |
| | Medium | $0.034 | $0.050 | $0.050 |
| | High | $0.133 | $0.200 | $0.200 |
| **GPT Image 1** | Low | $0.011 | $0.016 | $0.016 |
| | Medium | $0.042 | $0.063 | $0.063 |
| | High | $0.167 | $0.250 | $0.250 |
| **GPT Image 1 Mini** | Low | $0.005 | $0.006 | $0.006 |
| | Medium | $0.011 | $0.015 | $0.015 |
| | High | $0.036 | $0.052 | $0.052 |

> gpt-image-2 支持数千种有效分辨率，上表仅列出与前代模型相同的尺寸用于对比。

### 13.4 成本计算公式

**总成本 = 输入文本 token + 输入图片 token（编辑时） + 图片输出 token**

### 13.5 流式中间图片费用

每个 partial image 额外产生 **100 个图片输出 token**。

---

## 14. API 端点速查

| 端点 | 方法 | 用途 |
|------|------|------|
| `/v1/images/generations` | POST | 从文本提示词生成图片 |
| `/v1/images/edits` | POST | 编辑现有图片（支持参考图和 Mask） |
| `/v1/responses` | POST | 对话式图片生成/编辑（含 `image_generation` 工具） |
| `/v1/files` | POST | 上传文件获取 File ID（用于 Responses API 图片输入） |

### Image API 请求参数速查

**生成 (`/v1/images/generations`)：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 如 `gpt-image-2` |
| `prompt` | string | 是 | 文本提示词 |
| `n` | integer | 否 | 生成图片数量，默认 1 |
| `size` | string | 否 | 尺寸，默认 `auto` |
| `quality` | string | 否 | `low`/`medium`/`high`/`auto` |
| `output_format` | string | 否 | `png`/`jpeg`/`webp` |
| `output_compression` | integer | 否 | 压缩级别 0-100（仅 jpeg/webp） |
| `background` | string | 否 | `opaque`/`transparent`/`auto` |
| `moderation` | string | 否 | `auto`/`low` |
| `stream` | boolean | 否 | 是否流式输出 |
| `partial_images` | integer | 否 | 中间图片数量 0-3 |

**编辑 (`/v1/images/edits`)：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `model` | string | 是 | 如 `gpt-image-2` |
| `prompt` | string | 是 | 编辑指令 |
| `image` | file/array | 是 | 输入图片（支持多张） |
| `mask` | file | 否 | Mask 图片（需含 Alpha 通道） |
| `n` | integer | 否 | 生成图片数量 |
| `size` | string | 否 | 尺寸 |
| `quality` | string | 否 | 质量 |
| `output_format` | string | 否 | 输出格式 |
| `output_compression` | integer | 否 | 压缩级别 |
| `background` | string | 否 | 背景设置 |
| `moderation` | string | 否 | 审核严格度 |
| `stream` | boolean | 否 | 是否流式 |
| `partial_images` | integer | 否 | 中间图片数量 |

**Responses API 图片生成工具参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `type` | string | `"image_generation"` |
| `action` | string | `"auto"`/`"generate"`/`"edit"` |
| `quality` | string | `low`/`medium`/`high`/`auto` |
| `size` | string | 图片尺寸 |
| `output_format` | string | 输出格式 |
| `output_compression` | integer | 压缩级别 |
| `background` | string | 背景设置 |
| `partial_images` | integer | 流式中间图片数量 |
| `input_image_mask` | object | `{"file_id": "..."}` |

---

## 附录：关键提醒

1. **组织验证必须完成** 才能使用 GPT Image 模型
2. **gpt-image-2 不支持透明背景**
3. **Mask 必须包含 Alpha 通道**，且与编辑图片格式和尺寸一致
4. **JPEG 格式延迟最低**，适合对延迟敏感的场景
5. **quality: "low"** 适合快速迭代，最终产出再用 medium/high
6. 超过 **2K 分辨率** 的输出为实验性功能
7. 使用 Responses API 时，模型会**自动修订提示词**，可通过 `revised_prompt` 字段查看
8. 流式中间图片每张额外产生 **100 个输出 token**
