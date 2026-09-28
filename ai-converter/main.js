/*
  AI 资料转换器（HTML / 图片 → Markdown / PNG / Canvas）  v1.1.0
  ------------------------------------------------------------------
  · HTML → Markdown（本地抽取 + AI 整理）
  · HTML → PNG 长截图（无头浏览器，自动裁空白）
  · 图片 → Markdown（视觉模型，发送前自动压缩）
  · AI 生成知识画板（Obsidian Canvas，确定性布局不重叠，可配 AI 生图）
  · 侧边栏「AI 助手」面板：像聊天一样输入需求直接生成
  API：日日新（OpenAI 兼容），全部可在设置里配置。
*/
const obsidian = require('obsidian');
let fs = null, nodePath = null, execFile = null, NODE_OK = false;
try {
  fs = require('fs');
  nodePath = require('path');
  execFile = require('child_process').execFile;
  NODE_OK = true;
} catch (e) {
  console.error('[ai-converter] Node API 不可用，截图功能禁用：', e.message);
}

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'];
const HTML_EXT = ['html', 'htm'];

const PROMPT_HTML_DEF = `你是一个严谨的资料整理助手。下面是从一个网页里抽取出来的纯文本（可能夹杂导航、广告等噪音）。
请把它整理成结构清晰的 Markdown，要求：
1. 保留原文的标题层级与逻辑顺序，删掉导航、页脚、广告、"相关文章"之类的噪音
2. 保留代码块、表格、公式（如果有）
3. 不要添加原文没有的信息，不要写"总结"或"我的看法"
4. 只输出 Markdown 正文，不要任何解释性前后缀`;

const PROMPT_IMAGE_DEF = `你是一个严谨的资料整理助手。请把这张图片的内容整理成适合人阅读与知识管理的 Markdown：
1. 文字类内容：完整准确地转录，保留标题/列表/层级结构
2. 图表、流程图、示意图：先用一句话说明它展示什么，再用一个 Mermaid 代码块（flowchart 或 graph TD）还原结构关系，最后用要点列出关键数据
3. 数据表格：用 Markdown 表格转录
4. 照片/截图：客观描述画面内容与可见文字
5. 只输出 Markdown 正文；不要"这张图"之类的废话开头；绝不要编造图中不存在的细节`;

const PROMPT_CANVAS_DEF = `你把资料整理成 Obsidian Canvas 的结构。只输出严格的 JSON（不要 markdown 代码块包裹、不要任何解释），格式：
{"title":"画布标题","nodes":[{"id":"a","lane":0,"md":"# 主题\\n一句话","color":"1"}],"edges":[{"from":"a","to":"b","label":"关系"}]}
规则：
- lane 是列号：0=中心主题，1=主要分支，2=细节/延伸；同一列的节点自上而下排列
- edges 从左指向右，表达知识流；同列节点之间自上而下
- 每个节点的 md 用简短 markdown（标题+要点，最多 6 行，每行不超过 30 字）
- 节点总数 5~10 个；color 用 "1"~"6" 的预设色（同列尽量同色）`;

const DEFAULT_SETTINGS = {
  apiBase: 'https://token.sensenova.cn/v1',
  apiKey: '',
  textModel: 'sensenova-6.8-flash-lite',
  visionModel: 'sensenova-6.8-flash-lite',
  genImageModel: 'sensenova-u1-fast',
  maxTokens: 8000,
  imageMaxEdge: 2000,
  aiPolishHtml: true,
  promptHtml: PROMPT_HTML_DEF,
  promptImage: PROMPT_IMAGE_DEF,
  promptCanvas: PROMPT_CANVAS_DEF,
  outputSuffix: '-AI',
  attachmentFolder: '02-原始资料/附件',
  screenshotWidth: 1440,
  screenshotMaxHeight: 6000,
  browserPath: '',
  canvasWithImage: true,
};

function extOf(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }
function baseOf(name) { const i = name.lastIndexOf('.'); return i < 0 ? name : name.slice(0, i); }
function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '');
}
function htmlToText(raw) {
  let s = String(raw || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  const title = stripTags((s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  let body = (s.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || s;
  body = body.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (m, t, c) => '\n\n' + '#'.repeat(parseInt(t[1], 10)) + ' ' + stripTags(c).trim() + '\n\n');
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (m, c) => '\n- ' + stripTags(c).trim());
  body = body.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (m, c) => '\n\n```\n' + stripTags(c).trim() + '\n```\n\n');
  body = body.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, c) => { const t = stripTags(c).trim(); return t ? '[' + t + '](' + href + ')' : ''; });
  body = body.replace(/<(br|p|div|tr|section|article)[^>]*>/gi, '\n').replace(/<\/(p|div|tr|section|article|h[1-6]|ul|ol|table)>/gi, '\n');
  body = stripTags(body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title: title, text: body };
}
function today() { const d = new Date(); const p = n => n < 10 ? '0' + n : '' + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
function findBrowser(configured) {
  const cands = [configured,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const c of cands) { try { if (c && fs && fs.existsSync(c)) return c; } catch (e) { } }
  return '';
}
function extractJson(text) {
  const s = String(text || '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (e) { return null; }
}

/* ---------------- 模型调用（一律 requestUrl：渲染进程的 fetch 会被 CORS 拦） ---------------- */
async function callChat(settings, messages, model, maxTokens) {
  const key = (settings.apiKey || '').trim();
  if (!key) throw new Error('还没填 API Key（设置 → AI 资料转换器）');
  const url = (settings.apiBase || '').replace(/\/+$/, '') + '/chat/completions';
  async function once(mt) {
    const resp = await obsidian.requestUrl({
      url: url, method: 'POST', throw: false,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify({ model: model, messages: messages, max_tokens: Math.max(256, parseInt(mt, 10) || 8000) }),
    });
    const raw = resp.text;
    if (resp.status !== 200) {
      let hint = '';
      if (resp.status === 429) hint = '（触发限流，稍等几秒再试或换模型）';
      if (resp.status === 401) hint = '（API Key 无效）';
      throw new Error('HTTP ' + resp.status + ' ' + hint + ' ' + raw.slice(0, 240));
    }
    const j = JSON.parse(raw);
    const msg = (j.choices || [])[0] ? j.choices[0].message : {};
    let c = msg.content;
    if (Array.isArray(c)) c = c.map(x => typeof x === 'string' ? x : (x && x.text) || '').join('');
    return String(c || '').trim();
  }
  // 推理模型会把预算烧在思考上（实测 mt=16000 全空、8000 正常）→ 空则换档重试
  let out = await once(maxTokens);
  if (out) return out;
  out = await once(maxTokens >= 8000 ? 4000 : 8000);
  if (out) return out;
  throw new Error('模型返回空内容（推理模型把 token 都花在思考上了，可调整「最大输出 token」）');
}

/* ---------------- Canvas 布局（确定性，保证不重叠不遮挡） ---------------- */
function layoutCanvas(spec) {
  const COL_GAP = 170, ROW_GAP = 56;
  function dispW(s) { let w = 0; for (const ch of s) w += /[\u2E80-\u9FFF\uFF00-\uFFEF\u3000-\u303F]/.test(ch) ? 1 : 0.55; return w; }
  function estSize(md) {
    const lines = String(md || '').split('\n');
    let maxw = 0;
    for (const ln of lines) maxw = Math.max(maxw, dispW(ln));
    const width = Math.min(480, Math.max(240, Math.round(maxw * 14) + 64));
    const cpl = Math.max(8, Math.floor((width - 44) / 14));
    let rows = 0;
    for (const ln of lines) rows += Math.max(1, Math.ceil(dispW(ln) / cpl)) + (ln.trim().startsWith('#') ? 0.4 : 0);
    return { w: width, h: Math.max(110, Math.round(rows * 27 + 52)) };
  }
  const nodes = (spec.nodes || []).map(n => Object.assign({}, n, estSize(n.md || '')));
  const lanes = {};
  for (const n of nodes) { const L = parseInt(n.lane, 10) || 0; n.lane = L; (lanes[L] = lanes[L] || []).push(n); }
  const laneIds = Object.keys(lanes).map(Number).sort((a, b) => a - b);
  if (!laneIds.length) throw new Error('画布 JSON 里没有节点');
  const laneW = {}, laneH = {};
  for (const L of laneIds) {
    laneW[L] = Math.max.apply(null, lanes[L].map(n => n.w));
    laneH[L] = lanes[L].reduce((s, n) => s + n.h, 0) + ROW_GAP * (lanes[L].length - 1);
  }
  let x = 0; const laneX = {};
  for (const L of laneIds) { laneX[L] = x; x += laneW[L] + COL_GAP; }
  const totalH = Math.max.apply(null, laneIds.map(L => laneH[L]));
  for (const L of laneIds) {
    let y = (totalH - laneH[L]) / 2;
    for (const n of lanes[L]) {
      n.cx = Math.round(laneX[L] + (laneW[L] - n.w) / 2);
      n.cy = Math.round(y);
      y += n.h + ROW_GAP;
    }
  }
  const byId = {}; for (const n of nodes) byId[n.id] = n;
  const edges = []; let ei = 0;
  for (const e of (spec.edges || [])) {
    const a = byId[e.from], b = byId[e.to];
    if (!a || !b || a === b) continue;
    const dirs = (a.lane === b.lane) ? ['bottom', 'top'] : ((a.lane < b.lane) ? ['right', 'left'] : ['left', 'right']);
    edges.push({ id: 'e' + (ei++), fromSide: dirs[0], fromNode: a.id, toSide: dirs[1], toNode: b.id, label: e.label || undefined });
  }
  const cNodes = nodes.map(n => {
    const o = { id: n.id, x: n.cx, y: n.cy, width: n.w, height: n.h, type: 'text', text: n.md };
    if (n.color) o.color = String(n.color);
    return o;
  });
  return { nodes: cNodes, edges: edges, totalH: totalH, firstNode: nodes[0] || null };
}

/* ---------------- 视图：AI 助手侧边栏（Agent 式输入框） ---------------- */
class AiPanelView extends obsidian.ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return 'ai-converter-panel'; }
  getDisplayText() { return 'AI 助手（资料转换 / 画板）'; }
  getIcon() { return 'sparkles'; }
  async onOpen() {
    const root = this.contentEl;
    root.empty(); root.addClass('aic-panel');
    const p = this.plugin;
    root.createEl('div', { cls: 'aic-title', text: 'AI 助手' });
    const cur = root.createEl('div', { cls: 'aic-cur' });
    const refreshCur = () => { const f = p.app.workspace.getActiveFile(); cur.setText('当前文件：' + (f ? f.path : '（无）')); };
    refreshCur();
    this.registerEvent(p.app.workspace.on('active-leaf-change', refreshCur));
    root.createEl('div', { cls: 'aic-label', text: '你的要求（可留空 = 默认整理）：' });
    const ta = root.createEl('textarea', { cls: 'aic-input' });
    ta.rows = 4;
    ta.placeholder = '例：把这篇资料整理成知识画板，重点突出「增量编译」和 RAG 的对比；配一张示意图';
    const row = root.createDiv({ cls: 'aic-row' });
    const chk = row.createEl('label', { cls: 'aic-check' });
    const cb = chk.createEl('input', { type: 'checkbox' }); cb.checked = !!p.settings.canvasWithImage;
    chk.createEl('span', { text: ' 同时生成 AI 配图' });
    cb.onchange = async () => { p.settings.canvasWithImage = cb.checked; await p.saveSettings(); };
    const btn1 = row.createEl('button', { cls: 'aic-btn mod-cta', text: '生成知识画板' });
    const log = root.createDiv({ cls: 'aic-log' });
    const say = (t, cls) => { const d = log.createDiv({ cls: 'aic-line ' + (cls || '') }); d.setText(t); log.scrollTop = log.scrollHeight; };
    btn1.onclick = async () => {
      btn1.disabled = true;
      try { await p.agentGenerate(ta.value, say); }
      catch (e) { say('❌ ' + e.message, 'aic-err'); }
      btn1.disabled = false;
    };
    root.createEl('div', { cls: 'aic-label', text: '快捷操作（对当前文件）：' });
    const btns = root.createDiv({ cls: 'aic-row aic-wrap' });
    [['HTML/图片 → MD', () => { const f = p.app.workspace.getActiveFile(); if (f) p.convert(f); }],
     ['HTML → PNG 截图', () => { const f = p.app.workspace.getActiveFile(); if (f) p.htmlToPng(f); }],
     ['图片 → Markdown', () => { const f = p.app.workspace.getActiveFile(); if (f) p.imageToMd(f); }],
     ['测试连接', () => p.testApi()]].forEach(x => {
      btns.createEl('button', { cls: 'aic-btn', text: x[0] }).onclick = async () => {
        try { await x[1](); } catch (e) { say('❌ ' + e.message, 'aic-err'); }
      };
    });
  }
  async onClose() { this.contentEl.empty(); }
}

/* ---------------- 主插件 ---------------- */
class AiConverter extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView('ai-converter-panel', (leaf) => new AiPanelView(leaf, this));

    const self = this;
    this.addRibbonIcon('sparkles', 'AI 助手（资料转换 / 画板）', () => self.openPanel());

    this.addCommand({ id: 'open-panel', name: '打开 AI 助手面板', callback: () => self.openPanel() });
    this.addCommand({ id: 'ai-convert-current', name: 'AI 转换当前文件（HTML / 图片 → Markdown）',
      checkCallback: (checking) => {
        const f = self.app.workspace.getActiveFile(); if (!f) return false;
        const e = extOf(f.name);
        if (IMG_EXT.indexOf(e) < 0 && HTML_EXT.indexOf(e) < 0) return false;
        if (!checking) self.convert(f);
        return true;
      } });
    this.addCommand({ id: 'ai-html-to-png', name: 'HTML → PNG 长截图（当前文件）',
      checkCallback: (checking) => {
        const f = self.app.workspace.getActiveFile(); if (!f || HTML_EXT.indexOf(extOf(f.name)) < 0) return false;
        if (!checking) self.htmlToPng(f);
        return true;
      } });
    this.addCommand({ id: 'ai-image-to-md', name: '图片 → Markdown（视觉模型，当前文件）',
      checkCallback: (checking) => {
        const f = self.app.workspace.getActiveFile(); if (!f || IMG_EXT.indexOf(extOf(f.name)) < 0) return false;
        if (!checking) self.imageToMd(f);
        return true;
      } });
    this.addCommand({ id: 'ai-canvas-current', name: 'AI 生成知识画板（当前文件）',
      checkCallback: (checking) => {
        const f = self.app.workspace.getActiveFile();
        if (!f) return false;
        const e = extOf(f.name);
        if (IMG_EXT.indexOf(e) < 0 && HTML_EXT.indexOf(e) < 0 && e !== 'md') return false;
        if (!checking) self.agentGenerate('', null, f);
        return true;
      } });
    this.addCommand({ id: 'ai-batch-convert', name: '批量转换资料区未处理的 HTML / 图片',
      callback: () => self.batchConvert() });
    this.addCommand({ id: 'ai-test-api', name: '测试日日新 API 连接', callback: () => self.testApi() });

    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!file || !file.extension) return;
      const e = (file.extension || '').toLowerCase();
      if (IMG_EXT.indexOf(e) >= 0 || HTML_EXT.indexOf(e) >= 0 || e === 'md') {
        menu.addItem((item) => item.setTitle('AI：生成知识画板').setIcon('layout-dashboard')
          .onClick(() => self.agentGenerate('', null, file)));
      }
      if (IMG_EXT.indexOf(e) >= 0 || HTML_EXT.indexOf(e) >= 0) {
        menu.addItem((item) => item.setTitle('AI 转换 → Markdown').setIcon('sparkles')
          .onClick(() => self.convert(file)));
      }
      if (e === 'html' || e === 'htm') {
        menu.addItem((item) => item.setTitle('AI：HTML → PNG 长截图').setIcon('image')
          .onClick(() => self.htmlToPng(file)));
        menu.addItem((item) => item.setTitle('在 Obsidian 视图里打开（不用浏览器）').setIcon('globe')
          .onClick(() => self.openHtmlInView(file)));
      }
    }));

    this.addSettingTab(new AiConverterSettingTab(this.app, this));
  }
  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }
  onunload() { }

  openPanel() {
    const right = this.app.workspace.getRightLeaf(false);
    right.setViewState({ type: 'ai-converter-panel', active: true });
    this.app.workspace.revealLeaf(right);
  }

  absPath(file) {
    const base = this.app.vault.adapter.getBasePath && this.app.vault.adapter.getBasePath();
    return base ? base + nodePath.sep + file.path.split('/').join(nodePath.sep) : file.path;
  }
  siblingPath(file, suffix) {
    const folder = file.parent ? file.parent.path : '';
    return obsidian.normalizePath((folder ? folder + '/' : '') + baseOf(file.name) + (suffix || '-AI') + '.md');
  }
  async ensureFolder(pathStr) {
    const p = obsidian.normalizePath(pathStr);
    if (!this.app.vault.getAbstractFileByPath(p)) { await this.app.vault.createFolder(p).catch(() => { }); }
  }
  async writeNote(pathStr, content) {
    const exist = this.app.vault.getAbstractFileByPath(pathStr);
    if (exist) await this.app.vault.modify(exist, content); else await this.app.vault.create(pathStr, content);
  }

  openHtmlInView(file) {
    const leaf = this.app.workspace.getLeaf(true);
    leaf.setViewState({ type: 'si-html-view', state: { file: file.path } }).then(() => {
      new obsidian.Notice('已用 Obsidian 视图打开（若空白：请确认「资料采集器」插件已启用）');
    });
  }

  async convert(file) {
    const e = extOf(file.name);
    if (HTML_EXT.indexOf(e) >= 0) return this.htmlToMd(file);
    if (IMG_EXT.indexOf(e) >= 0) return this.imageToMd(file);
    new obsidian.Notice('这个文件类型不支持：.' + e);
  }

  /* ---------- HTML → Markdown ---------- */
  async htmlToMd(file) {
    const notice = new obsidian.Notice('正在转换 HTML → Markdown…', 0);
    try {
      const raw = await this.app.vault.read(file);
      const parsed = htmlToText(raw);
      let body = parsed.text, mode = '本地规则抽取';
      if (!body || body.replace(/\s/g, '').length < 120) {
        notice.hide();
        new obsidian.Notice('页面正文是 JS 动态渲染的，源码里抽不到内容。建议：右键 →「HTML → PNG 长截图」→ 再对 PNG「图片 → Markdown」（两步走）', 12000);
        return;
      }
      if (this.settings.aiPolishHtml) {
        notice.setMessage('正在让 AI 整理结构…');
        const clipped = body.length > 40000 ? body.slice(0, 40000) + '\n\n（内容过长已截断）' : body;
        const out = await callChat(this.settings, [
          { role: 'system', content: this.settings.promptHtml },
          { role: 'user', content: clipped },
        ], this.settings.textModel, this.settings.maxTokens);
        if (out && out.trim().length > 50) { body = out.trim(); mode = 'AI 整理（' + this.settings.textModel + '）'; }
      }
      const outPath = this.siblingPath(file, this.settings.outputSuffix);
      const md = ['---', 'title: ' + (parsed.title || baseOf(file.name)), 'type: 原始资料', 'status: 未编译',
        'kind: 网页转录', 'source_file: "[[' + file.name + ']]"', 'converted_by: ' + mode,
        'date_saved: ' + today(), 'tags: [原始资料, AI转换]', '---', '',
        '# ' + (parsed.title || baseOf(file.name)), '',
        '> 由「AI 资料转换器」从 `' + file.path + '` 转换而来（' + mode + '）', '',
        body, '', '---', '相关：[[03-知识库/总索引|总索引]]'].join('\n');
      await this.writeNote(outPath, md);
      notice.hide();
      new obsidian.Notice('已生成：' + outPath);
    } catch (e) { notice.hide(); new obsidian.Notice('转换失败：' + e.message, 8000); console.error('[ai-converter]', e); }
  }

  /* ---------- 图片：读图 + 压缩 ---------- */
  async imageDataUrl(file, maxEdge) {
    const buf = await this.app.vault.adapter.readBinary(file.path);
    try {
      const bmp = await createImageBitmap(new Blob([buf]));
      let w = bmp.width, h = bmp.height;
      const k = Math.min(1, maxEdge / Math.max(w, h));
      w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bmp, 0, 0, w, h);
      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      const mime = 'image/' + (extOf(file.name) === 'jpg' ? 'jpeg' : extOf(file.name));
      return 'data:' + mime + ';base64,' + Buffer.from(buf).toString('base64');
    }
  }

  /* ---------- 图片 → Markdown（产物里不嵌入原图，输出面向可视化） ---------- */
  async imageToMd(file, log) {
    const notice = log ? null : new obsidian.Notice('正在识别图片内容…', 0);
    const say = (t) => { if (log) log(t); else if (notice) notice.setMessage(t); };
    try {
      const dataUrl = await this.imageDataUrl(file, parseInt(this.settings.imageMaxEdge, 10) || 2000);
      const build = (du) => [
        { role: 'system', content: this.settings.promptImage },
        { role: 'user', content: [{ type: 'text', text: '请整理这张图片的内容。' }, { type: 'image_url', image_url: { url: du } }] },
      ];
      say('识别中…');
      let out = await callChat(this.settings, build(dataUrl), this.settings.visionModel, this.settings.maxTokens);
      if (/没有收到|未收到|没有附加|无法查看/.test(out)) {
        say('图片被 API 丢弃，压缩后重试…');
        const small = await this.imageDataUrl(file, 1100);
        const out2 = await callChat(this.settings, build(small), this.settings.visionModel, this.settings.maxTokens);
        if (!/没有收到|未收到|没有附加|无法查看/.test(out2)) out = out2;
        else out += '\n\n> ⚠️ 图片未被模型接收（可能过大），请对源图截图后重试。';
      }
      const outPath = this.siblingPath(file, this.settings.outputSuffix);
      const md = ['---', 'title: ' + baseOf(file.name) + '（图片识别）', 'type: 原始资料', 'status: 未编译',
        'kind: 图片转录', 'source_file: "[[' + file.name + ']]"', 'converted_by: ' + this.settings.visionModel,
        'date_saved: ' + today(), 'tags: [原始资料, AI转换]', '---', '',
        '> 由「AI 资料转换器」识别 `' + file.path + '` 生成（模型：' + this.settings.visionModel + '）',
        '> **AI 识别可能有误，关键数据请对照原图核对。**', '',
        out, '', '---', '相关：[[03-知识库/总索引|总索引]]'].join('\n');
      await this.writeNote(outPath, md);
      if (notice) notice.hide();
      say('✅ 已生成：' + outPath);
      if (!log) new obsidian.Notice('已生成：' + outPath);
      return outPath;
    } catch (e) {
      if (notice) notice.hide();
      if (log) log('❌ ' + e.message); else new obsidian.Notice('识别失败：' + e.message, 8000);
      console.error('[ai-converter]', e);
      throw e;
    }
  }

  /* ---------- HTML → PNG ---------- */
  async htmlToPng(file) {
    const notice = new obsidian.Notice('正在截图…', 0);
    try {
      if (!NODE_OK || !fs || !execFile) throw new Error('Node API 不可用（截图需要桌面版 Obsidian）');
      const browser = findBrowser(this.settings.browserPath);
      if (!browser) throw new Error('找不到 Edge / Chrome，请在设置里填浏览器路径');
      const folder = this.settings.attachmentFolder || '02-原始资料/附件';
      await this.ensureFolder(folder);
      const outPath = folder + '/' + baseOf(file.name) + '.png';
      const outAbs = this.app.vault.adapter.getBasePath() + nodePath.sep + outPath.split('/').join(nodePath.sep);
      const url = 'file:///' + this.absPath(file).split(nodePath.sep).join('/');
      const W = parseInt(this.settings.screenshotWidth, 10) || 1440;
      const H = parseInt(this.settings.screenshotMaxHeight, 10) || 6000;
      const os2 = require('os');
      const ud = nodePath.join(os2.tmpdir(), 'obsidian-ai-conv-profile');
      const common = ['--disable-gpu', '--hide-scrollbars', '--no-sandbox', '--no-first-run',
        '--no-default-browser-check', '--disable-extensions', '--user-data-dir=' + ud,
        '--window-size=' + W + ',' + H, '--screenshot=' + outAbs, url];
      const variants = [['--headless=old'], ['--headless=new'], []].map(h => h.concat(common));
      let lastErr = null;
      for (const args of variants) {
        try {
          if (fs.existsSync(outAbs)) fs.unlinkSync(outAbs);
          await new Promise((resolve, reject) => {
            execFile(browser, args, { timeout: 45000, windowsHide: true }, (err) => err ? reject(err) : resolve());
          });
          if (fs.existsSync(outAbs) && fs.statSync(outAbs).size > 2000) { lastErr = null; break; }
        } catch (e) { lastErr = e; }
      }
      if (!fs.existsSync(outAbs) || fs.statSync(outAbs).size < 2000)
        throw new Error('截图失败' + (lastErr ? '：' + lastErr.message : '（浏览器没输出图片）'));
      const trimmed = this.trimBottom(outAbs);
      notice.hide();
      new obsidian.Notice('已截图：' + outPath + (trimmed ? '（已裁掉底部空白）' : ''));
    } catch (e) { notice.hide(); new obsidian.Notice('截图失败：' + e.message, 8000); }
  }

  trimBottom(pngAbs) {
    try {
      if (!fs) return false;
      const electron = require('electron');
      const img = electron.nativeImage.createFromPath(pngAbs);
      const size = img.getSize(); const bmp = img.toBitmap();
      const w = size.width, h = size.height; if (!w || !h) return false;
      const b0 = bmp[0], g0 = bmp[1], r0 = bmp[2];
      let last = 0;
      for (let y = h - 1; y >= 0; y -= 2) {
        let empty = true;
        for (let x = 0; x < w; x += 32) {
          const i = (y * w + x) * 4;
          if (Math.abs(bmp[i] - b0) + Math.abs(bmp[i + 1] - g0) + Math.abs(bmp[i + 2] - r0) > 12) { empty = false; break; }
        }
        if (!empty) { last = y; break; }
      }
      if (last > 60 && last < h - 24) {
        fs.writeFileSync(pngAbs, img.crop({ x: 0, y: 0, width: w, height: last + 24 }).toPNG());
        return true;
      }
    } catch (e) { }
    return false;
  }

  /* ---------- 生图 ---------- */
  async genImage(prompt) {
    const resp = await obsidian.requestUrl({
      url: (this.settings.apiBase || '').replace(/\/+$/, '') + '/images/generations',
      method: 'POST', throw: false,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (this.settings.apiKey || '').trim() },
      body: JSON.stringify({ model: this.settings.genImageModel, prompt: prompt, n: 1, size: '1024x1024' }),
    });
    if (resp.status !== 200) throw new Error('生图失败 HTTP ' + resp.status + ' ' + resp.text.slice(0, 150));
    const j = JSON.parse(resp.text);
    const b64 = j.data && j.data[0] && (j.data[0].b64_json || '');
    if (!b64) throw new Error('生图返回里没有图片数据');
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
    const folder = this.settings.attachmentFolder || '02-原始资料/附件';
    await this.ensureFolder(folder);
    const path = folder + '/AI生成-' + Date.now() + '.png';
    await this.app.vault.adapter.writeBinary(obsidian.normalizePath(path), bin);
    return path;
  }

  /* ---------- AI 生成知识画板 ---------- */
  async agentGenerate(userRequest, log, forceFile) {
    const say = (t, cls) => { if (log) log(t, cls); else new obsidian.Notice(t); };
    const file = forceFile || this.app.workspace.getActiveFile();
    say('① 读取资料…');
    let content = '';
    if (file) {
      const e = extOf(file.name);
      if (e === 'md') { content = await this.app.vault.read(file); }
      else if (HTML_EXT.indexOf(e) >= 0) { content = htmlToText(await this.app.vault.read(file)).text; }
      else if (IMG_EXT.indexOf(e) >= 0) {
        say('① 图片 → 先用视觉模型转文字…');
        const outPath = await this.imageToMd(file, log);
        content = await this.app.vault.read(this.app.vault.getAbstractFileByPath(outPath));
      }
    }
    if (content.length > 30000) content = content.slice(0, 30000) + '\n（过长已截断）';
    say('② 让模型设计画布结构…');
    const userMsg = (userRequest ? '用户的额外要求：' + userRequest + '\n\n' : '') + '资料内容：\n' + (content || '（用户没有给具体资料，请围绕用户要求自拟主题）');
    const raw = await callChat(this.settings, [
      { role: 'system', content: this.settings.promptCanvas },
      { role: 'user', content: userMsg },
    ], this.settings.textModel, this.settings.maxTokens);
    const spec = extractJson(raw);
    if (!spec || !spec.nodes || !spec.nodes.length) throw new Error('模型没有输出合法的画布 JSON（再试一次，或在设置里检查画板提示词）');
    say('③ 布局并写入画布…');
    const layout = layoutCanvas(spec);
    const safeTitle = (spec.title || (file ? baseOf(file.name) : '知识画板')).replace(/[\\/:*?"<>|]/g, '');
    const canvasPath = (file && file.parent ? file.parent.path + '/' : '') + safeTitle + '-画板.canvas';
    const nodes = layout.nodes.slice();
    const edges = layout.edges.slice();

    if (this.settings.canvasWithImage) {
      say('④ AI 生成配图…（约 15~30 秒）');
      try {
        const imgPrompt = '知识可视化信息插图，主题：' + (spec.title || userRequest || (file && file.name) || '知识结构') +
          '。扁平风格信息图，白底，蓝紫配色，构图简洁清晰';
        const imgPath = await this.genImage(imgPrompt);
        nodes.push({ id: 'gen-img', x: 0, y: layout.totalH + 140, width: 480, height: 480, type: 'file', file: imgPath });
        if (layout.firstNode) {
          edges.push({ id: 'e-gen', fromSide: 'bottom', fromNode: layout.firstNode.id, toSide: 'top', toNode: 'gen-img', label: '配图' });
        }
      } catch (e) { say('⚠️ 配图失败：' + e.message); }
    }

    await this.writeNote(obsidian.normalizePath(canvasPath), JSON.stringify({ nodes: nodes, edges: edges }, null, 2));
    say('✅ 完成：' + canvasPath);
    this.app.workspace.getLeaf(true).setViewState({ type: 'canvas', state: { file: obsidian.normalizePath(canvasPath) } });
    return canvasPath;
  }

  /* ---------- 批量 / 测试 ---------- */
  async batchConvert() {
    const files = this.app.vault.getFiles().filter(f => {
      if (f.path.startsWith('.obsidian')) return false;
      const e = extOf(f.name);
      return IMG_EXT.indexOf(e) >= 0 || HTML_EXT.indexOf(e) >= 0;
    });
    let done = 0, skip = 0;
    const notice = new obsidian.Notice('批量转换中… 0/' + files.length, 0);
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (this.app.vault.getAbstractFileByPath(this.siblingPath(f, this.settings.outputSuffix))) { skip++; continue; }
      notice.setMessage('批量转换中… ' + (i + 1) + '/' + files.length + '　' + f.name);
      try { await this.convert(f); done++; } catch (e) { console.error('[ai-converter]', f.path, e); }
      await new Promise(r => setTimeout(r, 800));
    }
    notice.hide();
    new obsidian.Notice('批量完成：转换 ' + done + ' 个，跳过 ' + skip + ' 个');
  }

  async testApi() {
    const notice = new obsidian.Notice('正在测试…', 0);
    try {
      const resp = await obsidian.requestUrl({
        url: (this.settings.apiBase || '').replace(/\/+$/, '') + '/models', method: 'GET', throw: false,
        headers: { 'Authorization': 'Bearer ' + (this.settings.apiKey || '').trim() },
      });
      notice.hide();
      if (resp.status !== 200) { new obsidian.Notice('失败：HTTP ' + resp.status + ' ' + resp.text.slice(0, 200), 9000); return; }
      let ids = [];
      try { ids = (JSON.parse(resp.text).data || []).map(m => m.id); } catch (e) { }
      new obsidian.Notice('连接成功！可用模型：\n' + ids.join(', ').slice(0, 400), 12000);
    } catch (e) { notice.hide(); new obsidian.Notice('失败：' + e.message, 9000); }
  }
}

class AiConverterSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const c = this.containerEl; const s = this.plugin.settings; c.empty();
    c.createEl('h2', { text: 'AI 资料转换器' });
    c.createEl('p', { cls: 'setting-item-description', text: '调用日日新（SenseNova）大模型：HTML → Markdown / PNG、图片 → Markdown、AI 生成知识画板。OpenAI 兼容接口，换平台改地址和模型名即可。' });

    new obsidian.Setting(c).setName('API 地址').setDesc('默认 https://token.sensenova.cn/v1')
      .addText(t => { t.setValue(s.apiBase).onChange(async v => { s.apiBase = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.style.width = '320px'; });
    new obsidian.Setting(c).setName('API Key').setDesc('日日新控制台创建的 sk- 密钥（保存在本地 data.json，不进 git）')
      .addText(t => { t.setValue(s.apiKey).onChange(async v => { s.apiKey = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.type = 'password'; t.inputEl.style.width = '320px'; });
    new obsidian.Setting(c).setName('测试连接').setDesc('拉取模型列表确认配置')
      .addButton(b => b.setButtonText('测试').onClick(() => this.plugin.testApi()));
    new obsidian.Setting(c).setName('文本模型').setDesc('整理内容 / 画板结构，如 sensenova-6.8-flash-lite')
      .addText(t => { t.setValue(s.textModel).onChange(async v => { s.textModel = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.style.width = '320px'; });
    new obsidian.Setting(c).setName('视觉模型').setDesc('识别图片用，需支持图像输入')
      .addText(t => { t.setValue(s.visionModel).onChange(async v => { s.visionModel = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.style.width = '320px'; });
    new obsidian.Setting(c).setName('生图模型').setDesc('画板配图用，如 sensenova-u1-fast')
      .addText(t => { t.setValue(s.genImageModel).onChange(async v => { s.genImageModel = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.style.width = '320px'; });
    new obsidian.Setting(c).setName('最大输出 token')
      .setDesc('默认 8000。推理模型的思考也占预算（实测 16000 全空、8000 正常），空返回时自动换档重试')
      .addText(t => { t.setValue(String(s.maxTokens)).onChange(async v => { s.maxTokens = parseInt(v, 10) || 8000; await this.plugin.saveSettings(); }); t.inputEl.style.width = '120px'; });
    new obsidian.Setting(c).setName('图片压缩上限（最长边，像素）')
      .setDesc('发送前自动缩放转 JPEG。默认 2000 —— 超大图会被 API 静默丢弃（模型说"没收到图片"就是这个）')
      .addText(t => { t.setValue(String(s.imageMaxEdge)).onChange(async v => { s.imageMaxEdge = parseInt(v, 10) || 2000; await this.plugin.saveSettings(); }); t.inputEl.style.width = '120px'; });
    new obsidian.Setting(c).setName('用 AI 整理 HTML 转换结果')
      .addToggle(t => t.setValue(!!s.aiPolishHtml).onChange(async v => { s.aiPolishHtml = v; await this.plugin.saveSettings(); }));
    new obsidian.Setting(c).setName('画板自动配图')
      .setDesc('生成知识画板时，调用生图模型在画布上加一张主题插图')
      .addToggle(t => t.setValue(!!s.canvasWithImage).onChange(async v => { s.canvasWithImage = v; await this.plugin.saveSettings(); }));
    new obsidian.Setting(c).setName('HTML 转 Markdown 的提示词')
      .addTextArea(t => { t.setValue(s.promptHtml).onChange(async v => { s.promptHtml = v; await this.plugin.saveSettings(); }); t.inputEl.rows = 5; t.inputEl.style.width = '100%'; });
    new obsidian.Setting(c).setName('图片转 Markdown 的提示词')
      .setDesc('已按可视化优化：图表会转成 Mermaid 代码块 + 要点，表格转成 Markdown 表格')
      .addTextArea(t => { t.setValue(s.promptImage).onChange(async v => { s.promptImage = v; await this.plugin.saveSettings(); }); t.inputEl.rows = 6; t.inputEl.style.width = '100%'; });
    new obsidian.Setting(c).setName('知识画板的提示词')
      .setDesc('决定画板的节点/连线结构。模型输出 JSON，插件负责确定性布局（保证文本框不重叠不遮挡）')
      .addTextArea(t => { t.setValue(s.promptCanvas).onChange(async v => { s.promptCanvas = v; await this.plugin.saveSettings(); }); t.inputEl.rows = 8; t.inputEl.style.width = '100%'; });
    new obsidian.Setting(c).setName('输出文件后缀').setDesc('默认 -AI')
      .addText(t => { t.setValue(s.outputSuffix).onChange(async v => { s.outputSuffix = v.trim() || '-AI'; await this.plugin.saveSettings(); }); t.inputEl.style.width = '120px'; });

    c.createEl('h3', { text: 'HTML 截图' });
    new obsidian.Setting(c).setName('PNG 存放目录').setDesc('默认 02-原始资料/附件')
      .addText(t => { t.setValue(s.attachmentFolder).onChange(async v => { s.attachmentFolder = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.style.width = '320px'; });
    new obsidian.Setting(c).setName('截图宽度（像素）')
      .addText(t => { t.setValue(String(s.screenshotWidth)).onChange(async v => { s.screenshotWidth = parseInt(v, 10) || 1440; await this.plugin.saveSettings(); }); t.inputEl.style.width = '120px'; });
    new obsidian.Setting(c).setName('截图最大高度（像素）').setDesc('先整页渲染，再自动裁掉底部空白。默认 6000')
      .addText(t => { t.setValue(String(s.screenshotMaxHeight)).onChange(async v => { s.screenshotMaxHeight = parseInt(v, 10) || 6000; await this.plugin.saveSettings(); }); t.inputEl.style.width = '120px'; });
    new obsidian.Setting(c).setName('浏览器路径（可留空）').setDesc('留空自动找 Edge / Chrome')
      .addText(t => { t.setValue(s.browserPath).onChange(async v => { s.browserPath = v.trim(); await this.plugin.saveSettings(); }); t.inputEl.style.width = '380px'; });

    c.createEl('h3', { text: '怎么用' });
    const ul = c.createEl('ul');
    ['左侧边栏点 ✨ 打开「AI 助手」面板：写需求 → 生成知识画板（可配 AI 插图）',
      '文件列表右键 HTML / 图片 / md → AI 转换 / 生成画板 / 长截图',
      '生成画板时自动做确定性布局：节点尺寸按内容估算，保证不重叠不遮挡',
      '第一次用先点「测试连接」'].forEach(x => ul.createEl('li', { text: x }));
  }
}

module.exports = AiConverter;
