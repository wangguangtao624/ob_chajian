# Obsidian 插件：AI 资料转换器 & 资料采集器

面向「LLM 个人知识库」工作流（Karpathy 式：raw → wiki → outputs）的两个 Obsidian 插件，均使用中文界面。

> 实际使用场景见博客/笔记：用 Obsidian 当 IDE，LLM 当维护者，把图片、网页、HTML 全部喂进同一个知识库流水线。

## 插件一：AI 资料转换器（`ai-converter`）

调用 **日日新 SenseNova** 大模型（OpenAI 兼容接口，可换任意兼容平台），把非文本资料变成能进知识库的 Markdown：

| 功能 | 说明 |
|------|------|
| HTML → Markdown | 本地规则抽取正文 + AI 结构化整理（自动去导航/广告噪音） |
| HTML → PNG 长截图 | 调用本机 Edge/Chrome 无头渲染，自动裁掉底部空白；支持 JS 动态页面（两步走：截图 → 视觉识别） |
| 图片 → Markdown | 视觉模型 OCR/图表理解；图表会还原成 **Mermaid 代码块** + 要点，表格转 Markdown 表格 |
| **AI 生成知识画板** | 把任意资料变成 Obsidian Canvas：模型输出节点/连线 JSON，插件做**确定性布局**（节点尺寸按内容估算，保证不重叠、不遮挡），可自动生成 AI 配图插入画布 |
| AI 助手侧边栏 | Agent 式输入框：写需求 → 一键生成画板；附带常用转换快捷按钮 |

### 内置解决的问题（都是实测踩过的坑）

- **CORS**：渲染进程的 `fetch` 会被跨域策略拦截（报 `Failed to fetch`），一律改用 `requestUrl` 走主进程
- **超大图片被静默丢弃**：base64 超过 ~600KB 的图片，API 不报错但模型只收到文字——发送前自动缩放 + 转 JPEG，识别不到时自动压更小重试
- **推理模型空返回**：`sensenova-6.8-flash-lite` 的思考过程会吃掉 `max_tokens` 预算（16000 全烧在思考上返回空），自动换档重试
- **`--headless=new` 挂死**：Edge 的新无头模式会卡住，自动按 `old → new → 无参数` 逐组回退，并使用独立 user-data-dir 避免与运行中的浏览器冲突
- **Canvas 文本框遮挡**：布局是确定性计算（按内容估算宽高、分列排列），不依赖模型给坐标

### 安装

手动安装（社区市场未上架）：

1. 下载本仓库 `ai-converter/` 下的 `main.js`、`manifest.json`、`styles.css`
2. 放到 `<你的库>/.obsidian/plugins/ai-converter/`
3. 重启 Obsidian → 设置 → 第三方插件 → 启用

### 配置

设置里需要填：

- **API 地址**：默认 `https://token.sensenova.cn/v1`
- **API Key**：在[日日新开放平台](https://platform.sensenova.cn)创建（`sk-` 开头）
- **文本 / 视觉 / 生图模型**：默认 `sensenova-6.8-flash-lite`（文本+视觉）与 `sensenova-u1-fast`（生图）
- 两段提示词均可自定义；HTML 转 MD 的提示词、图片转 MD 的提示词、画板结构提示词分开配置

> Key 保存在本地 `.obsidian/plugins/ai-converter/data.json`，请勿提交到公开仓库。

### 使用

- 左侧边栏 ✨ 打开「AI 助手」面板：写需求 → 生成知识画板（可勾选 AI 配图）
- 文件列表右键任意 HTML / 图片 / Markdown → `AI 转换 → Markdown`、`AI：生成知识画板`、`AI：HTML → PNG 长截图`
- 或 `Ctrl+P` 命令面板搜索对应命令

## 插件二：资料采集器（`source-ingestor`）

让**图片和 HTML 像 Markdown 一样**进入知识库维护流程：

- **登记成资料**：把图片/网页生成带 frontmatter（`type/status/kind/abs_path`）的资料笔记，
  和普通笔记一样走「未编译 → 已编译」的编译流水线；`abs_path` 记录磁盘绝对路径，供 AI agent 直接读图
- **图片视图**：接管 PNG/JPG 打开方式——滚轮缩放、拖拽平移、适应窗口、1:1、旋转、双击切换
- **HTML 视图**：内容从内存注入（`srcdoc`，不会转圈加载不动），带缩放/适应宽度/重载/外部打开，脚本默认沙箱禁用
- **待编译清单**：一键导出所有未编译图片/网页（含绝对路径），直接贴给 AI agent

安装方式同上（`source-ingestor/` 目录）。

## 隐私与安全

- 所有资料与 API 调用仅在你本机与你配置的模型平台之间进行
- HTML 视图默认禁用页面脚本；生图/识别的提示词完全可自定义

## License

MIT
