/*
  资料采集器（图片 / 网页）
  ------------------------------------------------------------------
  把 vault 里的 PNG/图片 和 HTML 网页，登记成带 frontmatter 的原始资料笔记，
  让它们和 markdown 一样走进「未编译 → 已编译」的流水线。

  设计要点（对应 Karpathy 的 raw/ 层）：
  - 原始文件本身永远不动，只读
  - 生成的资料笔记带 type/status/sources/abs_path，AI 编译脚本据此扫描
  - abs_path 是关键：LLM 要看图必须拿到磁盘绝对路径
*/
const obsidian = require('obsidian');

const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tiff'];
const HTML_EXT = ['html', 'htm', 'mhtml', 'mht'];

const DEFAULT_SETTINGS = {
  imageNoteFolder: '02-原始资料/图片',
  htmlNoteFolder: '02-原始资料/网页',
  statusValue: '未编译',
  includeAbsPath: true,
  autoOnCreate: false,
  handleHtml: true,    // 接管 .html 的打开方式（自带缩放 / 适应宽度，中文界面）
  htmlAllowScript: false,  // 是否允许 HTML 里的脚本运行（默认关，安全）
  handleImage: true,   // 是否接管图片文件的打开方式（自带缩放 / 平移 / 适应窗口）
};

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
function baseOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? name : name.slice(0, i);
}
function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  const titleRaw = (s.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const descRaw = (s.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i) || [])[1] || '';
  let body = (s.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1] || s;
  body = body.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, function (m, t, c) {
    return '\n\n' + '#'.repeat(parseInt(t[1], 10)) + ' ' + stripTags(c).trim() + '\n\n';
  });
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, function (m, c) {
    return '\n- ' + stripTags(c).trim();
  });
  body = body.replace(/<a\s+[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, function (m, href, c) {
    const t = stripTags(c).trim();
    return t ? '[' + t + '](' + href + ')' : '';
  });
  body = body.replace(/<(br|p|div|tr|section|article)[^>]*>/gi, '\n');
  body = body.replace(/<\/(p|div|tr|section|article|h[1-6]|ul|ol|table)>/gi, '\n');
  body = stripTags(body);
  body = body.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    title: stripTags(titleRaw).trim(),
    description: stripTags(descRaw).trim(),
    body: body,
  };
}
function today() {
  const d = new Date();
  const p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

class SourceIngestor extends obsidian.Plugin {
  async onload() {
    await this.loadSettings();

    // —— HTML 视图（带缩放 / 适应宽度 / 外部打开）。默认让给 HTML Canvas，可在设置里切换 ——
    this.registerView('si-html-view', (leaf) => new SiHtmlView(leaf, this));
    try {
      if (this.settings.handleHtml) {
        this.registerExtensions(HTML_EXT, 'si-html-view');
      }
    } catch (e) {
      console.warn('[资料采集器] 注册 html 扩展名失败：', e.message);
    }

    // —— 图片视图：滚轮缩放 / 拖拽平移 / 适应窗口 / 1:1 ——
    this.registerView('si-image-view', (leaf) => new SiImageView(leaf, this));
    try {
      if (this.settings.handleImage) {
        this.registerExtensions(IMG_EXT, 'si-image-view');
      }
    } catch (e) {
      console.warn('[资料采集器] 注册图片扩展名失败：', e.message);
    }

    // 1) 登记当前文件
    this.addCommand({
      id: 'ingest-current-file',
      name: '把当前文件登记成原始资料（图片 / 网页）',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        const e = extOf(f.name);
        if (IMG_EXT.indexOf(e) < 0 && HTML_EXT.indexOf(e) < 0) return false;
        if (!checking) this.ingest(f);
        return true;
      },
    });

    // 2) 批量登记
    this.addCommand({
      id: 'ingest-all',
      name: '批量登记：扫描全库，为未登记的图片和网页建资料笔记',
      callback: async () => {
        const files = this.app.vault.getFiles().filter((f) => {
          if (f.path.startsWith('.obsidian')) return false;
          const e = extOf(f.name);
          return IMG_EXT.indexOf(e) >= 0 || HTML_EXT.indexOf(e) >= 0;
        });
        let made = 0, skipped = 0;
        for (const f of files) {
          const ok = await this.ingest(f, true);
          if (ok) made++; else skipped++;
        }
        new obsidian.Notice('资料采集器：新建 ' + made + ' 篇，跳过 ' + skipped + ' 篇（已登记）');
      },
    });

    // 3) 待编译清单（给 agent 用）
    this.addCommand({
      id: 'copy-pending-list',
      name: '复制「待编译的图片 / 网页」清单（含绝对路径）',
      callback: async () => {
        const txt = await this.buildPendingList();
        await navigator.clipboard.writeText(txt);
        new obsidian.Notice('已复制 ' + txt.split('\n').length + ' 行到剪贴板，可直接贴给 agent');
      },
    });

    // 4) 把清单写成笔记
    this.addCommand({
      id: 'write-pending-note',
      name: '生成「待编译清单」笔记到 03-知识库/体检报告',
      callback: async () => {
        const txt = await this.buildPendingList();
        const p = '03-知识库/体检报告/待编译清单-' + today() + '.md';
        const exist = this.app.vault.getAbstractFileByPath(p);
        if (exist) await this.app.vault.modify(exist, txt);
        else await this.app.vault.create(p, txt);
        new obsidian.Notice('已写入 ' + p);
      },
    });

    // 5) 用系统默认程序打开（图片 / 网页都适用）
    this.addCommand({
      id: 'open-in-system',
      name: '用系统默认程序打开当前文件（图片 / 网页）',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f) return false;
        const e = extOf(f.name);
        if (IMG_EXT.indexOf(e) < 0 && HTML_EXT.indexOf(e) < 0) return false;
        if (!checking) {
          try { this.app.openWithDefaultApp(f.path); }
          catch (err) { new obsidian.Notice('打不开：' + err.message); }
        }
        return true;
      },
    });

    this.addSettingTab(new SourceIngestorSettingTab(this.app, this));

    // 可选：新建图片/网页时自动登记
    this.registerEvent(
      this.app.vault.on('create', (f) => {
        if (!this.settings.autoOnCreate) return;
        const e = extOf(f.name);
        if (IMG_EXT.indexOf(e) >= 0 || HTML_EXT.indexOf(e) >= 0) {
          setTimeout(() => this.ingest(f, true), 500);
        }
      })
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  absPath(file) {
    try {
      const base = this.app.vault.adapter.getBasePath && this.app.vault.adapter.getBasePath();
      if (base) return base.replace(/\\/g, '\\') + '\\' + file.path.replace(/\//g, '\\');
    } catch (e) { /* ignore */ }
    return file.path;
  }

  notePathFor(file) {
    const e = extOf(file.name);
    const isImg = IMG_EXT.indexOf(e) >= 0;
    const folder = isImg ? this.settings.imageNoteFolder : this.settings.htmlNoteFolder;
    const name = baseOf(file.name) + '.md';
    return obsidian.normalizePath((folder ? folder + '/' : '') + name);
  }

  async ingest(file, quiet) {
    const notePath = this.notePathFor(file);
    if (this.app.vault.getAbstractFileByPath(notePath)) {
      if (!quiet) new obsidian.Notice('已经登记过了：' + notePath);
      return false;
    }
    const e = extOf(file.name);
    const isImg = IMG_EXT.indexOf(e) >= 0;
    let content;
    if (isImg) {
      content = this.imageNote(file);
    } else {
      let raw = '';
      try { raw = await this.app.vault.read(file); } catch (err) { raw = ''; }
      content = this.htmlNote(file, raw);
    }
    await this.app.vault.create(notePath, content);
    if (!quiet) new obsidian.Notice('已登记：' + notePath);
    return true;
  }

  imageNote(file) {
    const name = file.name;
    const abs = this.settings.includeAbsPath ? this.absPath(file) : '';
    return [
      '---',
      'title: ' + name,
      'type: 原始资料',
      'status: ' + this.settings.statusValue,
      'source: 本地文件',
      'kind: 图片',
      'file: "[[' + name + ']]"',
      'abs_path: "' + abs + '"',
      'date_saved: ' + today(),
      'tags: [原始资料, 图片]',
      '---',
      '',
      '# ' + name,
      '',
      '![[' + name + ']]',
      '',
      '> 原始文件：`' + file.path + '`',
      '> 绝对路径：`' + abs + '` ← **给 agent 看图的路径**',
      '',
      '## 我认为关键的点',
      '<!-- ✍️ 自己写：这张图是什么、为什么存、它回答了你的什么问题 -->',
      '',
      '## AI 看图后的描述',
      '<!-- 🤖 由具备视觉能力的 agent 填充：图里有什么、数据/结论是什么 -->',
      '',
      '## 待查',
      '',
      '---',
      '相关：[[03-知识库/总索引|总索引]]',
    ].join('\n');
  }

  htmlNote(file, raw) {
    const p = htmlToText(raw);
    const title = p.title || file.name;
    const abs = this.settings.includeAbsPath ? this.absPath(file) : '';
    const head = [
      '---',
      'title: ' + title,
      'type: 原始资料',
      'status: ' + this.settings.statusValue,
      'source: 本地文件',
      'kind: 网页',
      'file: "[[' + file.name + ']]"',
      'abs_path: "' + abs + '"',
      'date_saved: ' + today(),
      'tags: [原始资料, 网页]',
      '---',
      '',
      '# ' + title,
      '',
      '> 原始文件：`' + file.path + '`',
      '> 在 Obsidian 里点这个文件即可原样渲染（HTML Canvas 插件）',
      '',
      '## 我认为关键的点',
      '<!-- ✍️ 自己写 -->',
      '',
      '## 正文提取（由插件自动转成 markdown）',
      '',
      p.body || '_（未能提取到正文，请直接打开原 HTML 查看）_',
      '',
      '---',
      '相关：[[03-知识库/总索引|总索引]]',
    ];
    if (p.description) head.splice(head.indexOf('## 我认为关键的点'), 0, '> ' + p.description, '');
    return head.join('\n');
  }

  async buildPendingList() {
    const files = this.app.vault.getFiles().filter((f) => {
      if (f.path.startsWith('.obsidian') || f.path.startsWith('03-知识库') || f.path.startsWith('04-产出')) return false;
      const e = extOf(f.name);
      return IMG_EXT.indexOf(e) >= 0 || HTML_EXT.indexOf(e) >= 0;
    });
    const lines = [
      '---',
      'title: 待编译清单 ' + today(),
      'type: 体检报告',
      'created: ' + today(),
      'tags: [产出]',
      '---',
      '',
      '# 待编译的图片 / 网页（' + today() + '）',
      '',
      '> 交给 agent 时贴这段：**请读取下面这些文件（图片用视觉能力看，HTML 直接读文本），',
      '> 按 `05-提示词/01-编译成知识库.md` 编译进 03-知识库，并把每条的 status 改成 已编译。**',
      '',
      '| 类型 | 文件 | 绝对路径 | 资料笔记 |',
      '|------|------|----------|----------|',
    ];
    let n = 0;
    for (const f of files) {
      const notePath = this.notePathFor(f);
      const note = this.app.vault.getAbstractFileByPath(notePath);
      if (!note) continue;
      let status = '';
      try {
        const t = await this.app.vault.cachedRead(note);
        const m = t.match(/^status:\s*(.+)$/m);
        status = m ? m[1].trim() : '';
      } catch (e) { /* ignore */ }
      if (status && status !== '未编译') continue;
      n++;
      const kind = IMG_EXT.indexOf(extOf(f.name)) >= 0 ? '图片' : '网页';
      lines.push('| ' + kind + ' | ' + f.name + ' | `' + this.absPath(f) + '` | [[' + note.basename + ']] |');
    }
    if (n === 0) lines.push('| — | 全部已编译，没有待处理项 | | |');
    lines.push('');
    lines.push('共 ' + n + ' 项待编译。');
    return lines.join('\n');
  }

  onunload() { /* nothing to clean */ }
}

/* ------------------------------------------------------------------
   图片视图：让 png/jpg 打开后像 md 一样能缩放、平移、适应窗口
   （Obsidian 原生图片视图不支持缩放，这里补上）
   ------------------------------------------------------------------ */
class SiImageView extends obsidian.FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.scale = 1;
    this.fitScale = 1;
    this.rot = 0;
  }
  getViewType() { return 'si-image-view'; }
  getDisplayText() { return this.file ? this.file.name : '图片'; }
  getIcon() { return 'image'; }
  canAcceptExtension(ext) { return IMG_EXT.indexOf(ext) >= 0; }

  async onLoadFile(file) {
    this.render(file);
  }
  async onUnloadFile() {
    this.contentEl.empty();
  }

  render(file) {
    const root = this.contentEl;
    root.empty();
    root.addClass('si-img-root');

    const bar = root.createDiv({ cls: 'si-html-bar' });
    const mk = (label, title, fn) => {
      const b = bar.createEl('button', { text: label, attr: { title: title } });
      b.addClass('si-html-btn');
      b.onclick = fn;
      return b;
    };
    mk('−', '缩小（滚轮 / -）', () => this.zoomBy(1 / 1.15));
    this.pct = bar.createSpan({ cls: 'si-html-pct', text: '100%' });
    mk('+', '放大（滚轮 / =）', () => this.zoomBy(1.15));
    mk('适应窗口', '缩放到刚好放进窗口（双击图片也行）', () => this.fit());
    mk('1:1', '原始像素大小', () => this.setScale(1));
    mk('旋转', '顺时针 90°', () => this.rotate());
    mk('外部打开', '用系统默认程序打开', () => {
      try { this.app.openWithDefaultApp(file.path); }
      catch (e) { window.open(this.app.vault.getResourcePath(file)); }
    });

    const holder = root.createDiv({ cls: 'si-img-holder' });
    const img = holder.createEl('img', { cls: 'si-img' });
    this.holder = holder;
    this.img = img;
    this.rot = 0;
    img.onload = () => {
      this.natW = img.naturalWidth || 800;
      this.natH = img.naturalHeight || 600;
      this.fit();
    };
    img.src = this.app.vault.getResourcePath(file);

    // 滚轮缩放（以光标为锚点，和看图软件一个手感）
    this.registerDomEvent(holder, 'wheel', (e) => {
      e.preventDefault();
      const rect = holder.getBoundingClientRect();
      const px = e.clientX - rect.left + holder.scrollLeft;
      const py = e.clientY - rect.top + holder.scrollTop;
      const old = this.scale;
      this.zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12);
      const k = this.scale / old;
      holder.scrollLeft = px * k - (e.clientX - rect.left);
      holder.scrollTop = py * k - (e.clientY - rect.top);
    }, { passive: false });

    // 按住左键拖拽平移
    let drag = null;
    this.registerDomEvent(holder, 'mousedown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, sl: holder.scrollLeft, st: holder.scrollTop };
      holder.addClass('si-grabbing');
      e.preventDefault();
    });
    this.registerDomEvent(window, 'mousemove', (e) => {
      if (!drag) return;
      holder.scrollLeft = drag.sl - (e.clientX - drag.x);
      holder.scrollTop = drag.st - (e.clientY - drag.y);
    });
    this.registerDomEvent(window, 'mouseup', () => {
      drag = null;
      holder.removeClass('si-grabbing');
    });

    // 双击：适应窗口 ↔ 1:1
    this.registerDomEvent(holder, 'dblclick', () => {
      if (Math.abs(this.scale - this.fitScale) < 0.01) this.setScale(1);
      else this.fit();
    });

    // 键盘：= 放大 / - 缩小 / 0 适应窗口
    this.scope.register([], '=', () => { this.zoomBy(1.15); return false; });
    this.scope.register([], '-', () => { this.zoomBy(1 / 1.15); return false; });
    this.scope.register([], '0', () => { this.fit(); return false; });
  }

  apply() {
    if (!this.img) return;
    this.img.style.width = Math.max(1, Math.round(this.natW * this.scale)) + 'px';
    this.img.style.height = Math.max(1, Math.round(this.natH * this.scale)) + 'px';
    this.img.style.transform = this.rot ? 'rotate(' + this.rot + 'deg)' : '';
    if (this.pct) this.pct.setText(Math.round(this.scale * 100) + '%');
  }
  setScale(s) {
    this.scale = Math.min(8, Math.max(0.05, s));
    this.apply();
  }
  zoomBy(k) { this.setScale(this.scale * k); }
  rotate() { this.rot = (this.rot + 90) % 360; this.apply(); }
  fit() {
    if (!this.holder || !this.natW) return;
    const availW = Math.max(50, this.holder.clientWidth - 20);
    const availH = Math.max(50, this.holder.clientHeight - 20);
    this.fitScale = Math.min(availW / this.natW, availH / this.natH, 1);
    this.setScale(this.fitScale);
    this.holder.scrollLeft = 0;
    this.holder.scrollTop = 0;
  }
}

/* ------------------------------------------------------------------
   HTML 视图：像看网页一样看 .html，带缩放 / 适应宽度 / 外部打开
   缩放用 CSS zoom（Chromium 原生支持，会真正影响布局，等同浏览器缩放）
   ------------------------------------------------------------------ */
class SiHtmlView extends obsidian.FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.zoom = 1;
  }
  getViewType() { return 'si-html-view'; }
  getDisplayText() { return this.file ? this.file.name : '网页'; }
  getIcon() { return 'globe'; }
  canAcceptExtension(ext) { return HTML_EXT.indexOf(ext) >= 0; }

  async onLoadFile(file) {
    await this.render(file);
  }
  async onUnloadFile() {
    this.contentEl.empty();
  }

  async render(file) {
    const root = this.contentEl;
    root.empty();
    root.addClass('si-html-root');

    const bar = root.createDiv({ cls: 'si-html-bar' });
    const mk = (label, title, fn) => {
      const b = bar.createEl('button', { text: label, attr: { title: title } });
      b.addClass('si-html-btn');
      b.onclick = fn;
      return b;
    };
    mk('−', '缩小（Ctrl + 滚轮 / Ctrl + -）', () => this.setZoom(this.zoom / 1.15));
    this.pct = bar.createSpan({ cls: 'si-html-pct', text: '100%' });
    mk('+', '放大（Ctrl + 滚轮 / Ctrl + =）', () => this.setZoom(this.zoom * 1.15));
    mk('适应宽度', '按窗口宽度排版（100%）', () => this.setZoom(1));
    mk('重载', '重新载入这个 html', () => this.render(this.file));
    mk('外部打开', '用系统浏览器打开', () => {
      window.open(this.app.vault.getResourcePath(file));
    });

    const holder = root.createDiv({ cls: 'si-html-holder' });
    const frame = holder.createEl('iframe', { cls: 'si-html-frame' });
    const allowScript = !!this.plugin.settings.htmlAllowScript;
    frame.setAttribute('sandbox', allowScript
      ? 'allow-same-origin allow-scripts allow-forms allow-popups allow-modals'
      : 'allow-same-origin allow-forms');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    this.holder = holder;
    this.frame = frame;

    // 关键：内容直接从内存注入（srcdoc），不走 file:// 加载 ——
    // 老方案靠 iframe.src 指向 vault 资源，遇到外部资源会一直挂着转圈。
    const ext = (file.extension || '').toLowerCase();
    if (ext === 'mht' || ext === 'mhtml') {
      frame.src = this.app.vault.getResourcePath(file);   // MHTML 是打包格式，只能走原生加载
    } else {
      let raw = '';
      try {
        raw = await this.app.vault.read(file);
      } catch (err) {
        raw = '';
      }
      if (!raw || !raw.trim()) {
        raw = '<div style="font-family:system-ui;padding:24px;color:#888">（读不到文件内容）</div>';
      } else {
        // 注入 <base>，让 HTML 里引用的相对图片/CSS 仍能解析到 vault 路径
        const rp = this.app.vault.getResourcePath(file);
        const dir = rp.slice(0, rp.lastIndexOf('/') + 1);
        if (!/<base\s/i.test(raw)) {
          if (/<head[^>]*>/i.test(raw)) {
            raw = raw.replace(/<head([^>]*)>/i, '<head$1><base href="' + dir + '">');
          } else {
            raw = '<base href="' + dir + '">' + raw;
          }
        }
      }
      frame.srcdoc = raw;
    }

    // Ctrl + 滚轮缩放（和 Obsidian 看图的习惯一致）
    this.registerDomEvent(holder, 'wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    this.applyZoom();
  }

  setZoom(z) {
    this.zoom = Math.min(5, Math.max(0.25, z));
    this.applyZoom();
  }
  applyZoom() {
    if (this.frame) this.frame.style.zoom = String(this.zoom);
    if (this.pct) this.pct.setText(Math.round(this.zoom * 100) + '%');
  }
}

class SourceIngestorSettingTab extends obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const c = this.containerEl;
    c.empty();
    new obsidian.Setting(c).setName('图片资料笔记存放目录').setDesc('图片对应的 .md 放哪').addText((t) =>
      t.setValue(this.plugin.settings.imageNoteFolder).onChange(async (v) => {
        this.plugin.settings.imageNoteFolder = v;
        await this.plugin.saveSettings();
      })
    );
    new obsidian.Setting(c).setName('网页资料笔记存放目录').setDesc('HTML 对应的 .md 放哪').addText((t) =>
      t.setValue(this.plugin.settings.htmlNoteFolder).onChange(async (v) => {
        this.plugin.settings.htmlNoteFolder = v;
        await this.plugin.saveSettings();
      })
    );
    new obsidian.Setting(c).setName('新资料的初始状态').setDesc('编译流水线靠这个字段扫描').addText((t) =>
      t.setValue(this.plugin.settings.statusValue).onChange(async (v) => {
        this.plugin.settings.statusValue = v;
        await this.plugin.saveSettings();
      })
    );
    new obsidian.Setting(c).setName('记录绝对路径').setDesc('LLM 看图需要磁盘绝对路径，建议开启').addToggle((t) =>
      t.setValue(this.plugin.settings.includeAbsPath).onChange(async (v) => {
        this.plugin.settings.includeAbsPath = v;
        await this.plugin.saveSettings();
      })
    );
    new obsidian.Setting(c).setName('新增图片/网页时自动登记').setDesc('默认关闭，避免噪音').addToggle((t) =>
      t.setValue(this.plugin.settings.autoOnCreate).onChange(async (v) => {
        this.plugin.settings.autoOnCreate = v;
        await this.plugin.saveSettings();
      })
    );
    new obsidian.Setting(c)
      .setName('接管图片文件的打开方式')
      .setDesc('开启后点开 png/jpg 等，会用本插件的视图打开：滚轮缩放、拖拽平移、适应窗口、1:1、旋转。'
        + '改完需重载：Ctrl+P → Reload app without saving')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.handleImage).onChange(async (v) => {
          this.plugin.settings.handleImage = v;
          await this.plugin.saveSettings();
          new obsidian.Notice(v ? '已接管图片视图 —— 重载 Obsidian 后生效' : '已交还 Obsidian 原生图片视图 —— 重载后生效');
        })
      );
    new obsidian.Setting(c)
      .setName('接管 .html 的打开方式')
      .setDesc('开启后点开 .html 用本插件的中文视图：缩放 / 适应宽度 / 重载 / 外部打开。'
        + '内容直接从内存注入，不会像外部加载那样转圈。改完需重载：Ctrl+P → Reload app without saving')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.handleHtml).onChange(async (v) => {
          this.plugin.settings.handleHtml = v;
          await this.plugin.saveSettings();
          new obsidian.Notice('已' + (v ? '开启' : '关闭') + ' HTML 视图 —— 重载 Obsidian 后生效');
        })
      );
    new obsidian.Setting(c)
      .setName('允许 HTML 里的脚本运行')
      .setDesc('默认关闭（更安全，只渲染排版与样式）。遇到依赖 JS 才能显示的网页时再打开')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.htmlAllowScript).onChange(async (v) => {
          this.plugin.settings.htmlAllowScript = v;
          await this.plugin.saveSettings();
          new obsidian.Notice('点视图里的「重载」按钮后生效');
        })
      );
  }
}

module.exports = SourceIngestor;
