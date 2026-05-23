# Enterprise Knowledge Agent

基于 LangGraph 的企业智能知识库 Agent，采用**摘要路由 + 按需加载**架构，无需向量数据库，实现 90%+ 的 Token 节省。

> 部署平台：[EdgeOne Pages](https://edgeone.ai/pages) | [English](./README.md)

## 核心理念

传统知识库方案需要将所有文档向量化存入向量数据库，查询时扫描全量 Embedding。本项目采用完全不同的思路：

```
用户提问
    ↓
Agent 读取【文档摘要层】（极轻量，每篇仅 200 字）
    ↓
LLM 自主判断：应该去哪 1-2 篇文档里找答案
    ↓
按需加载选中文档的完整内容
    ↓
基于原文生成回答（未被选中的文档 = 零 Token 消耗）
```

## 架构

```
┌─────────────────── LangGraph StateGraph ───────────────────┐
│                                                             │
│   START → [Router] → [Load Docs] → [Generate Answer] → END │
│              │              │                                │
│         读取摘要       按需加载原文                            │
│        (所有文档)     (仅选中的1-2篇)                         │
└─────────────────────────────────────────────────────────────┘

存储层 (EdgeOne Pages Blob):
  summary/{docId}.json  →  每篇文档的摘要 + 关键词
  docs/{docId}.txt      →  文档完整原文
```

## 对比传统 RAG

| 维度 | 传统 RAG (向量检索) | 本方案 (摘要路由) |
|------|--------------------|--------------------|
| 向量数据库 | 必须 (Pinecone/Weaviate/Chroma) | **不需要** |
| Embedding 计算 | 每次上传全量 Embedding | **不需要** |
| 查询 Token 消耗 | 高 (Top-K chunks 全部送入 LLM) | **低** (仅加载选中文档) |
| 文档更新 | 需重新索引 | **替换文件即可** |
| 100 篇文档场景 | ~8000 tokens/query | **~1200 tokens/query** |

## 功能特性

- **智能路由**：LLM 基于摘要自主决策去哪里找答案
- **多格式支持**：PDF、Word (.docx)、Excel (.xlsx)、PPT (.pptx)、Markdown、TXT、CSV、JSON、LaTeX、代码文件
- **三种导入方式**：前端拖拽上传 / 批量 API / CLI 脚本
- **实时决策可视化**：SSE 流式展示 Agent 路由过程（选了哪些文档、为什么）
- **EdgeOne Pages 部署**：Serverless，零运维

## 技术栈

| 层 | 技术 |
|----|------|
| Agent 框架 | [LangGraph.js](https://github.com/langchain-ai/langgraphjs) (StateGraph) |
| 前端 | Next.js 16 + React 19 + Tailwind CSS |
| LLM | EdgeOne AI Gateway (支持 DeepSeek / GPT 等) |
| 存储 | EdgeOne Pages Blob (无需外部数据库) |
| 文档解析 | pdf-parse + mammoth + xlsx + jszip |

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

```env
AI_GATEWAY_BASE_URL=https://your-gateway.edgeone.ai/v1
AI_GATEWAY_API_KEY=your-api-key
AI_MODEL=@Pages/deepseek-v4-flash
```

### 3. 本地开发

```bash
edgeone pages dev -t <your-token>
```

### 4. 批量导入文档（可选）

```bash
npx tsx scripts/import.ts ./your-docs-folder
```

### 5. 部署

```bash
edgeone pages deploy
```

## 项目结构

```
├── agents/
│   ├── _shared.ts         # 共享工具 (Model, SSE, Logger)
│   ├── chat.ts            # 核心: LangGraph 按需检索 Agent
│   ├── upload.ts          # 单文件上传 + 摘要生成
│   ├── batch-upload.ts    # 批量上传 Agent (SSE 流式进度)
│   ├── manage.ts          # 文档管理 (列表/删除)
│   └── stop.ts            # 中止运行
├── lib/
│   ├── doc-store.ts       # Blob 存储层 (基于 list API，无竞态)
│   └── parser.ts          # 多格式文档解析器
├── app/
│   ├── page.tsx           # 主页面
│   └── components/
│       ├── chat-panel.tsx       # 对话界面 (SSE streaming)
│       ├── upload-zone.tsx      # 拖拽上传 (支持二进制文件)
│       └── document-list.tsx    # 文档列表 (可展开摘要)
├── scripts/
│   └── import.ts          # CLI 批量导入脚本
└── edgeone.json           # EdgeOne Pages 部署配置
```

## 工作原理

### 上传流程

```
文件 → parser.ts 提取文本 → AI Gateway 生成摘要+关键词 → Blob 存储
```

支持格式：PDF, DOCX, XLSX, PPTX, MD, TXT, CSV, JSON, TEX, 代码文件

### 查询流程

```
问题 → Router (读摘要, LLM选文档) → Load Docs (按需加载) → Generate (引用来源回答)
```

SSE 实时推送每个节点的执行状态，前端展示完整决策过程。

### 为什么不需要向量数据库？

1. **摘要层极轻量**：每篇 200 字，100 篇文档总摘要才 20K tokens
2. **LLM 理解力 > 余弦相似度**：语义路由比向量匹配更准确
3. **真正按需**：未被选中的文档 = 零消耗，不像向量检索要扫描全部 Embedding

## API 端点

| Method | Path | 说明 |
|--------|------|------|
| POST | `/chat` | 智能问答 (SSE streaming) |
| POST | `/upload` | 上传单个文档 |
| POST | `/batch-upload` | 批量上传 (SSE 进度) |
| POST | `/manage` | 列出/删除文档 |
| POST | `/stop` | 终止运行中的查询 |

## 环境变量

| 变量 | 必须 | 说明 |
|------|------|------|
| `AI_GATEWAY_BASE_URL` | Yes | EdgeOne AI Gateway 地址 |
| `AI_GATEWAY_API_KEY` | Yes | AI Gateway API Key |
| `AI_MODEL` | No | 模型名 (默认 `@Pages/deepseek-v4-flash`) |
| `PROJECT_ID` | No | Blob 存储项目 ID (部署时自动注入) |
| `EDGEONE_PAGES_API_TOKEN` | No | Blob 存储 Token (部署时自动注入) |

## License

MIT
