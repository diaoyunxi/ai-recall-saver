/**
 * AI撤回保存器 - 核心内容脚本 (v1.0.5 书签版诊断增强)
 *
 * v1.0.0 的问题：
 *  - 流式输出时 markdown 重渲染触发海量 childList 删除事件，被误判为"撤回"，
 *    瞬间产生 99+ 假记录。
 *  - 每个 mutation 同步 querySelectorAll 遍历整棵 DOM，阻塞主线程导致页面卡死。
 *
 * v1.0.1 修复要点：
 *  1. 流式检测：内容持续增长 → 标记 streaming → 期间不判定撤回、不处理删除
 *  2. 确认快照(confirmedSnapshots)：只在内容稳定 1.5s 后更新，作为撤回判定基准
 *  3. 延迟确认删除：节点删除后等 600ms，若期间原位置出现等价内容(重渲染)则取消
 *  4. mutation 批处理：debounce 300ms 批量处理，不逐条同步执行
 *  5. content nodes 缓存：避免每次 querySelectorAll
 *  6. observer 降级：去掉 characterData，只保留 childList + 必要 attributes
 *
 * v1.0.3 降低误报率方案（重点修复"内容覆盖误报"与"节点隐藏误报"）：
 *  1. SENSITIVITY 三档配置（strict 默认 / balanced / aggressive），阈值与延迟全可配置
 *     由 popup 写入 chrome.storage.local.sensitivity，content 启动读取并监听变化
 *  2. handleHide 增加延迟确认（严格 1000ms）+ 恢复可见取消 + 可见相似度二次校验
 *     修复折叠展开、切换深浅色主题、虚拟列表滚动、模态框 aria-hidden 临时变化误报
 *  3. checkContentRecall 阈值可配置（严格减少>85%）+ 二次相似度校验，降低 markdown 重渲染误报
 *  4. pageStillHasSimilarContent 改为前缀+后缀双校验 + 长度阈值提升至 98% + 最短文本要求
 *     新增 pageHasVisibleSimilarContent 跳过被隐藏节点，专供 handleHide
 *  5. addRecord 去重窗口可配置（严格 8s）+ 最小快照长度可配置
 *  6. DEBUG_MODE 调试日志开关，便于排查误报（chrome.storage.local.debugMode）
 *
 * v1.0.5 书签版修复（诊断 + 简易 UI）：
 *  1. ensureUI() 真正实现悬浮按钮 (FAB) 和极简侧边面板，不再静默失效
 *  2. openPanel / renderList / showFullText / exportRecords 全部实现，书签版可用
 *  3. init() 增加诊断 Toast：节点识别为空时明确提示用户选择器可能已失效
 *  4. 增加 DeepSeek SSE 直接监听（从 content.js 移植），降低对 DOM 选择器的依赖
 *  5. debugMode 开启时打印站点配置和检测到的节点列表，便于排查
 *
 * 暴露 window.__AISaver__ 供 popup / 控制台调用。
 */
(function() {
  "use strict";

  // ===== 内嵌站点配置（来自 sites.js） =====
  /**
   * AI撤回保存器 - 站点配置
   *
   * 为每个支持的 AI 网页版提供 DOM 选择器与识别规则。
   * 由于各站点前端使用 CSS Modules（类名带哈希），此处同时提供
   * "属性/结构启发式选择器" 作为兜底，content.js 还内置通用兜底逻辑。
   *
   * 配置字段说明：
   *  - name:           站点显示名
   *  - rootSelectors:  对话列表根容器选择器（用于挂载 MutationObserver），按优先级排列
   *  - messageSelectors: 单条 AI 消息项的选择器
   *  - contentSelectors: 消息正文（markdown 渲染区）选择器
   *  - assistantHints:   判断某个消息项是否为 AI 回复的辅助条件（类名/属性关键词）
   *  - regenerateSelectors: "重新生成"按钮选择器（点击时覆盖前保存）
   *  - excludeSelectors: 需要排除的选择器（如用户输入框、代码块工具栏）
   */
  const SITES = {
      // ===== DeepSeek =====
      "chat.deepseek.com": {
        name: "DeepSeek",
        rootSelectors: [
          ".ds-chat--main",
          "[class*='chat--']",
          "main",
          "[class*='conversation']"
        ],
        messageSelectors: [
          "[class*='message--']",
          "[class*='msg--']",
          ".ds-message"
        ],
        contentSelectors: [
          ".ds-markdown",
          "[class*='markdown']",
          "[class*='message--content']"
        ],
        assistantHints: ["role-assistant", "assistant", "ds-markdown"],
        regenerateSelectors: [
          "[class*='regenerate']",
          "button[aria-label*='重新生成']",
          "button[aria-label*='Regenerate']"
        ],
        excludeSelectors: [
          "[class*='input']",
          "textarea",
          "pre code"
        ]
      },
  
      // ===== Kimi (月之暗面) =====
      "kimi.moonshot.cn": {
        name: "Kimi",
        rootSelectors: [
          "[class*='chatContent']",
          "[class*='chat-content']",
          "[class*='conversation']",
          "main"
        ],
        messageSelectors: [
          "[class*='chatContentItem']",
          "[class*='message-item']",
          "[class*='assistant']"
        ],
        contentSelectors: [
          ".mark_down",
          "[class*='markdown']",
          "[class*='contentText']"
        ],
        assistantHints: ["assistant", "bot", "kimi"],
        regenerateSelectors: [
          "[class*='regenerate']",
          "button[aria-label*='重新']"
        ],
        excludeSelectors: ["textarea", "[class*='editor']"]
      },
  
      // ===== Kimi 新域名 =====
      "kimi.com": {
        name: "Kimi",
        rootSelectors: [
          "[class*='chatContent']",
          "[class*='chat']",
          "main"
        ],
        messageSelectors: [
          "[class*='chatContentItem']",
          "[class*='message']",
          "[class*='assistant']"
        ],
        contentSelectors: [
          ".mark_down",
          "[class*='markdown']",
          "[class*='contentText']"
        ],
        assistantHints: ["assistant", "bot", "kimi"],
        regenerateSelectors: ["[class*='regenerate']"],
        excludeSelectors: ["textarea", "[class*='editor']"]
      },
  
      // ===== 通义千问 =====
      "tongyi.aliyun.com": {
        name: "通义千问",
        rootSelectors: [
          "[class*='chat-content']",
          "[class*='conversation']",
          "[class*='message-list']",
          "main"
        ],
        messageSelectors: [
          "[class*='message-item']",
          "[class*='bubble']",
          "[class*='reply']"
        ],
        contentSelectors: [
          "[class*='markdown']",
          "[class*='bubble-content']",
          "[class*='reply-content']"
        ],
        assistantHints: ["assistant", "bot", "tongyi"],
        regenerateSelectors: [
          "[class*='regenerate']",
          "button[aria-label*='重新']"
        ],
        excludeSelectors: ["textarea", "[class*='input']"]
      },
  
      // ===== 豆包 =====
      "www.doubao.com": {
        name: "豆包",
        rootSelectors: [
          "[class*='chat-content']",
          "[class*='conversation']",
          "[class*='message-list']",
          "main"
        ],
        messageSelectors: [
          "[class*='message-item']",
          "[class*='receive']",
          "[class*='assistant']"
        ],
        contentSelectors: [
          "[class*='markdown']",
          "[class*='content-text']",
          "[class*='bubble-content']"
        ],
        assistantHints: ["assistant", "bot", "receive"],
        regenerateSelectors: [
          "[class*='regenerate']",
          "button[aria-label*='重新']"
        ],
        excludeSelectors: ["textarea", "[class*='input']"]
      },
  
      // ===== 智谱清言 =====
      "chatglm.cn": {
        name: "智谱清言",
        rootSelectors: [
          "[class*='chat-content']",
          "[class*='conversation']",
          "[class*='message-list']",
          "main"
        ],
        messageSelectors: [
          "[class*='message-item']",
          "[class*='bubble']",
          "[class*='assistant']"
        ],
        contentSelectors: [
          ".markdown-body",
          "[class*='markdown']"
        ],
        assistantHints: ["assistant", "bot", "chatglm"],
        regenerateSelectors: [
          "[class*='regenerate']",
          "button[aria-label*='重新']"
        ],
        excludeSelectors: ["textarea", "[class*='input']"]
      },
  
      // ===== 智谱清言 (z.ai) =====
      "chat.z.ai": {
        name: "智谱清言",
        rootSelectors: [
          "[class*='chat-content']",
          "[class*='conversation']",
          "main"
        ],
        messageSelectors: [
          "[class*='message-item']",
          "[class*='bubble']",
          "[class*='assistant']"
        ],
        contentSelectors: [
          ".markdown-body",
          "[class*='markdown']"
        ],
        assistantHints: ["assistant", "bot"],
        regenerateSelectors: ["[class*='regenerate']"],
        excludeSelectors: ["textarea", "[class*='input']"]
      },
  
      "chat.zhipuai.cn": {
        name: "智谱清言",
        rootSelectors: ["[class*='chat-content']", "main"],
        messageSelectors: ["[class*='message-item']", "[class*='assistant']"],
        contentSelectors: [".markdown-body", "[class*='markdown']"],
        assistantHints: ["assistant", "bot"],
        regenerateSelectors: ["[class*='regenerate']"],
        excludeSelectors: ["textarea", "[class*='input']"]
      },
  
      // ===== 文心一言 =====
      "yiyan.baidu.com": {
        name: "文心一言",
        rootSelectors: [
          "[class*='chat-content']",
          "[class*='conversation']",
          "[class*='message-list']",
          "main"
        ],
        messageSelectors: [
          "[class*='message-item']",
          "[class*='bubble']",
          "[class*='reply']"
        ],
        contentSelectors: [
          "[class*='markdown']",
          "[class*='reply-content']",
          "[class*='content-text']"
        ],
        assistantHints: ["assistant", "bot", "yiyan"],
        regenerateSelectors: [
          "[class*='regenerate']",
          "button[aria-label*='重新']"
        ],
        excludeSelectors: ["textarea", "[class*='input']"]
      },
  
      // ===== 腾讯元宝 =====
      "yuanbao.tencent.com": {
        name: "腾讯元宝",
        rootSelectors: [
          "[class*='chat-content']",
          "[class*='conversation']",
          "[class*='message-list']",
          "main"
        ],
        messageSelectors: [
          "[class*='message-item']",
          "[class*='bubble']",
          "[class*='agent']"
        ],
        contentSelectors: [
          "[class*='markdown']",
          "[class*='bubble-content']",
          "[class*='content-text']"
        ],
        assistantHints: ["assistant", "bot", "agent"],
        regenerateSelectors: [
          "[class*='regenerate']",
          "button[aria-label*='重新']"
        ],
        excludeSelectors: ["textarea", "[class*='input']"]
      }
    };
  
    // 通用兜底配置（任意站点均适用，content.js 在站点选择器失效时回退使用）
    const FALLBACK = {
      name: "通用AI站点",
      rootSelectors: ["main", "[role='main']", "body"],
      messageSelectors: [
        "[class*='message']",
        "[class*='bubble']",
        "[class*='reply']",
        "[class*='chat-item']"
      ],
      contentSelectors: [
        "[class*='markdown']",
        ".markdown-body",
        "[class*='content-text']",
        "[class*='bubble-content']"
      ],
      assistantHints: ["assistant", "bot"],
      regenerateSelectors: [
        "[class*='regenerate']",
        "button[aria-label*='重新生成']",
        "button[aria-label*='Regenerate']",
        "button[title*='重新']"
      ],
      excludeSelectors: ["textarea", "input", "[contenteditable]", "pre code"]
    };
  
    // v1.0.3：统一排除基线，所有站点（含 FALLBACK）自动合并，降低各站点 excludeSelectors 单薄导致的误报
    // 覆盖：输入框、编辑器、代码块、消息工具栏、模态框、抽屉、Toast、通知、侧边栏、历史会话、导航页头页脚
    const EXCLUDE_BASELINE = [
      "textarea",
      "input",
      "[contenteditable]",
      "pre code",
      "[class*='input']",
      "[class*='editor']",
      "[class*='toolbar']",
      "[class*='action']",
      "[class*='operate']",
      "[class*='tools']",
      "[role='dialog']",
      "[class*='modal']",
      "[class*='drawer']",
      "[class*='toast']",
      "[class*='notification']",
      "[class*='notice']",
      "[role='alert']",
      "[class*='sidebar']",
      "[class*='history']",
      "[class*='aside']",
      "nav",
      "header",
      "footer"
    ];
  
    // 数组去重合并工具
    function mergeUnique() {
      const out = [];
      const seen = new Set();
      for (let i = 0; i < arguments.length; i++) {
        const list = arguments[i];
        if (!Array.isArray(list)) continue;
        for (const sel of list) {
          if (seen.has(sel)) continue;
          seen.add(sel);
          out.push(sel);
        }
      }
      return out;
    }
  
    /**
     * 根据当前 hostname 获取站点配置
     * @param {string} hostname
     * @returns {object} 合并了 fallback 与统一排除基线的站点配置
     */
    function getSiteConfig(hostname) {
      const exact = SITES[hostname];
      if (!exact) {
        // v1.0.3：FALLBACK 也合并统一排除基线
        const fb = Object.assign({ key: "fallback", hostname }, FALLBACK);
        fb.excludeSelectors = mergeUnique(FALLBACK.excludeSelectors, EXCLUDE_BASELINE);
        return fb;
      }
      const merged = Object.assign({ key: hostname, hostname }, FALLBACK, exact);
      // v1.0.3：合并 站点自身 + FALLBACK + 统一基线 三者 excludeSelectors（去重）
      merged.excludeSelectors = mergeUnique(exact.excludeSelectors, FALLBACK.excludeSelectors, EXCLUDE_BASELINE);
      return merged;
    }
  



  // 防止重复注入
  if (window.__AISaverLoaded__) return;
  window.__AISaverLoaded__ = true;

  const STORE = window.__AISaver__ || (window.__AISaver__ = {});
  STORE.records = STORE.records || [];

  // ============================================================
  // 灵敏度配置（三档：严格 / 平衡 / 激进）
  // ============================================================
  // v1.0.3 新增：降低误报率方案
  // 由 popup 写入 chrome.storage.local.sensitivity，content 启动时读取并监听变化
  // - strict(默认)：宁可漏判，阈值高、延迟长、二次校验严格，适合误报敏感场景
  // - balanced：折中，接近 v1.0.2 行为
  // - aggressive：宁可误报，阈值低、延迟短，适合撤回高频且容忍噪声的场景
  const SENSITIVITY_PRESETS = {
    strict: {
      name: "严格",
      hideDelay: 1000,            // 隐藏延迟确认 ms（v1.0.2 为 0，立即记录，是隐藏误报主因）
      removeDelay: 800,           // 删除延迟确认 ms（v1.0.2 为 600）
      shrinkThreshold: 0.15,      // 骤减判定：当前长度 < 确认长度 * 0.15 触发（即减少 >85%）；v1.0.2 为 0.3（减少 >70%）
      minConfirmedLen: 30,        // 触发骤减判定的最小确认长度（v1.0.2 为 20）
      minSnapshotLen: 5,          // 记录快照的最小长度（v1.0.2 为 3）
      similarityRatio: 0.98,      // pageStillHasSimilarContent 长度阈值（v1.0.2 为 0.85）
      similarityPrefix: 80,      // 相似度前缀比对长度（v1.0.2 为 50）
      similaritySuffix: 30,      // 相似度后缀比对长度（v1.0.3 新增，v1.0.2 无）
      minSimilarityLen: 30,      // 参与相似度判定的最小文本长度（v1.0.3 新增）
      dedupWindow: 8000,         // 去重窗口 ms（v1.0.2 为 3000）
      hideRequireSimilarCheck: true // 隐藏判定是否做相似度二次校验（v1.0.2 为 false）
    },
    balanced: {
      name: "平衡",
      hideDelay: 600,
      removeDelay: 600,
      shrinkThreshold: 0.30,
      minConfirmedLen: 20,
      minSnapshotLen: 3,
      similarityRatio: 0.95,
      similarityPrefix: 60,
      similaritySuffix: 20,
      minSimilarityLen: 20,
      dedupWindow: 5000,
      hideRequireSimilarCheck: true
    },
    aggressive: {
      name: "激进",
      hideDelay: 300,
      removeDelay: 400,
      shrinkThreshold: 0.40,
      minConfirmedLen: 15,
      minSnapshotLen: 3,
      similarityRatio: 0.90,
      similarityPrefix: 40,
      similaritySuffix: 15,
      minSimilarityLen: 10,
      dedupWindow: 3000,
      hideRequireSimilarCheck: false
    }
  };

  let SENSITIVITY = SENSITIVITY_PRESETS.strict;
  let DEBUG_MODE = false;

  // 调试日志：仅在 DEBUG_MODE 开启时输出，便于排查误报
  function debug() {
    if (!DEBUG_MODE) return;
    try {
      const args = Array.prototype.slice.call(arguments);
      args.unshift("[AI撤回保存器]");
      console.debug.apply(console, args);
    } catch (e) {}
  }

  // 从 window.__AISaverConfig__ 加载配置（书签版不使用 chrome.storage）
  function loadConfig() {
    try {
      const cfg = window.__AISaverConfig__ || {};
      if (cfg.sensitivity && SENSITIVITY_PRESETS[cfg.sensitivity]) {
        SENSITIVITY = SENSITIVITY_PRESETS[cfg.sensitivity];
      }
      DEBUG_MODE = !!cfg.debugMode;
      debug("配置已加载", { sensitivity: SENSITIVITY.name, debug: DEBUG_MODE });
    } catch (e) {}
  }

  const SITE = getSiteConfig(location.hostname);

  // ============================================================
  // 工具函数
  // ============================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function debounce(fn, wait) {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), wait);
    };
  }

  function hashStr(s) {
    let h = 5381, i = s.length;
    while (i) h = (h * 33) ^ s.charCodeAt(--i);
    return (h >>> 0).toString(36);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function sanitizeHtml(html) {
    if (!html) return "";
    const template = document.createElement("template");
    template.innerHTML = html;
    const root = template.content;
    const dangerous = root.querySelectorAll("script, iframe, object, embed, form, base, link, meta, style");
    dangerous.forEach((el) => el.remove());
    const allEls = root.querySelectorAll("*");
    allEls.forEach((el) => {
      [...el.attributes].forEach((attr) => {
        if (/^on/i.test(attr.name)) {
          el.removeAttribute(attr.name);
        } else if (/^(href|src|action|formaction|xlink:href)$/i.test(attr.name)) {
          const val = (attr.value || "").trim().toLowerCase();
          if (/^(javascript|data|vbscript):/i.test(val)) {
            el.removeAttribute(attr.name);
          }
        }
      });
      if (el.hasAttribute("style")) {
        const style = el.getAttribute("style") || "";
        if (/expression\s*\(|url\s*\(\s*['"]?\s*javascript:/i.test(style)) {
          el.removeAttribute("style");
        }
      }
    });
    const div = document.createElement("div");
    div.appendChild(template.content.cloneNode(true));
    return div.innerHTML;
  }

  function truncate(s, n) {
    s = (s || "").trim();
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, "0");
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function isDarkMode() {
    return (
      document.documentElement.getAttribute("data-theme") === "dark" ||
      document.documentElement.classList.contains("dark") ||
      document.body.classList.contains("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function shouldExclude(node) {
    if (!node || node.nodeType !== 1) return true;
    if (node.hasAttribute && node.hasAttribute("data-aisaver")) return true;
    if (node.id && node.id.indexOf("aisaver") === 0) return true;
    for (const sel of SITE.excludeSelectors) {
      try { if (node.matches && node.matches(sel)) return true; } catch (e) {}
    }
    return false;
  }

  // ============================================================
  // AI 消息节点识别 + 缓存
  // ============================================================
  let cachedContentNodes = null;
  let cacheInvalidAt = 0;

  function collectAIContentNodes(force) {
    // 缓存 800ms，避免高频调用
    const now = Date.now();
    if (!force && cachedContentNodes && now < cacheInvalidAt) return cachedContentNodes;

    const out = [];
    const seen = new Set();

    for (const sel of SITE.contentSelectors) {
      let nodes = [];
      try { nodes = $$(sel); } catch (e) { continue; }
      for (const n of nodes) {
        if (seen.has(n) || shouldExclude(n)) continue;
        if (looksLikeAssistantContent(n)) { seen.add(n); out.push(n); }
      }
    }
    if (out.length === 0) {
      for (const sel of SITE.messageSelectors) {
        let items = [];
        try { items = $$(sel); } catch (e) { continue; }
        for (const item of items) {
          if (shouldExclude(item) || !looksLikeAssistantMessage(item)) continue;
          const inner = findLongestTextBlock(item);
          if (inner && !seen.has(inner)) { seen.add(inner); out.push(inner); }
        }
      }
    }
    cachedContentNodes = out;
    cacheInvalidAt = now + 800;
    return out;
  }

  function looksLikeAssistantContent(node) {
    const text = (node.textContent || "").trim();
    if (text.length < 5) return false;
    const tag = node.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return false;
    if (node.isContentEditable) return false;
    return true;
  }

  function looksLikeAssistantMessage(item) {
    const cls = (item.className && item.className.toString().toLowerCase()) || "";
    for (const h of SITE.assistantHints) {
      if (cls.indexOf(h.toLowerCase()) >= 0) return true;
    }
    for (const sel of SITE.contentSelectors) {
      try {
        if (item.querySelector && item.querySelector(sel)) {
          if ((item.textContent || "").trim().length > 20) return true;
        }
      } catch (e) {}
    }
    return false;
  }

  function findLongestTextBlock(root) {
    let best = null, bestLen = 0;
    const walk = (el) => {
      if (shouldExclude(el)) return;
      const t = (el.textContent || "").trim();
      if (t.length > bestLen && el.children.length < 50) { bestLen = t.length; best = el; }
      for (const c of el.children) walk(c);
    };
    walk(root);
    return best;
  }

  function isContentLike(node) {
    if (!node || node.nodeType !== 1) return false;
    const cls = (node.className && node.className.toString().toLowerCase()) || "";
    if (cls.indexOf("markdown") >= 0) return true;
    for (const sel of SITE.contentSelectors) {
      try { if (node.matches && node.matches(sel)) return true; } catch (e) {}
    }
    return false;
  }

  function collectAIContentNodesIn(root) {
    const out = [];
    if (!root || !root.querySelectorAll) return out;
    for (const sel of SITE.contentSelectors) {
      let nodes = [];
      try { nodes = Array.from(root.querySelectorAll(sel)); } catch (e) { continue; }
      for (const n of nodes) {
        if (!shouldExclude(n) && looksLikeAssistantContent(n)) out.push(n);
      }
    }
    if (out.length === 0 && root.nodeType === 1 && (root.textContent || "").trim().length > 30 && !shouldExclude(root)) {
      out.push(root);
    }
    return out;
  }

  // ============================================================
  // 快照 + 流式检测
  // ============================================================
  // confirmedSnapshots: 只在内容稳定后更新，是撤回判定的基准
  const confirmedSnapshots = new WeakMap();
  // streamingSnapshots: 流式期间实时更新，用于检测何时停止
  const streamingSnapshots = new WeakMap();

  let isStreaming = false;
  let streamingTimer = null;
  let lastTotalLength = 0;

  function takeSnapshot(node) {
    return {
      text: (node.textContent || "").trim(),
      html: node.innerHTML,
      ts: Date.now()
    };
  }

  // 检测流式输出：内容总长度增长 → streaming
  function detectStreaming() {
    const nodes = collectAIContentNodes();
    let totalLen = 0;
    for (const n of nodes) totalLen += (n.textContent || "").trim().length;

    if (totalLen > lastTotalLength + 5) {
      // 内容在增长 → 流式中
      if (!isStreaming) {
        isStreaming = true;
      }
      // 更新流式快照
      for (const n of nodes) {
        streamingSnapshots.set(n, takeSnapshot(n));
      }
      // 重置稳定计时器
      clearTimeout(streamingTimer);
      streamingTimer = setTimeout(onStreamStable, 1500);
    }
    lastTotalLength = totalLen;
  }

  // 流式结束：将流式期间的最新快照"确认"为基准
  function onStreamStable() {
    isStreaming = false;
    const nodes = collectAIContentNodes(true);
    for (const n of nodes) {
      // 关键：用流式期间的最新版本（streamingSnapshots）作为确认快照，
      // 而非当前可能已骤减的内容。这样才能检测到"流式增长后被撤回"。
      const streamSnap = streamingSnapshots.get(n);
      if (streamSnap) {
        confirmedSnapshots.set(n, streamSnap);
      } else {
        confirmedSnapshots.set(n, takeSnapshot(n));
      }
    }
    // 检查是否在稳定期间发生了骤减（真正的覆盖/撤回）
    checkContentRecall();
  }

  // ============================================================
  // 撤回判定
  // ============================================================

  // 内容覆盖/清空判定（非流式时）
  // v1.0.3：阈值与最小长度改为可配置，并增加二次相似度校验，降低 markdown 重渲染误报
  function checkContentRecall() {
    if (isStreaming) return;
    const nodes = collectAIContentNodes();
    for (const n of nodes) {
      const confirmed = confirmedSnapshots.get(n);
      if (!confirmed) continue;
      const curText = (n.textContent || "").trim();
      // 骤减判定：确认快照长度达标，当前长度小于阈值比例
      // 严格：减少 >85%；平衡：减少 >70%；激进：减少 >60%
      if (confirmed.text.length >= SENSITIVITY.minConfirmedLen && curText.length < confirmed.text.length * SENSITIVITY.shrinkThreshold) {
        // v1.0.3 二次校验：若页面其他位置仍存在高度相似内容，视为重渲染而非撤回
        if (pageStillHasSimilarContent(confirmed.text)) {
          debug("骤减但页面仍有相似内容，判定为重渲染", { confirmedLen: confirmed.text.length, curLen: curText.length });
          confirmedSnapshots.set(n, takeSnapshot(n));
          continue;
        }
        debug("判定为内容覆盖/清空撤回", { confirmedLen: confirmed.text.length, curLen: curText.length, threshold: SENSITIVITY.shrinkThreshold });
        if (addRecord("replace", confirmed)) {
          insertRestoreBlock(n.parentElement || n, n.nextSibling, confirmed, "内容被覆盖/清空");
        }
        // 更新为当前内容，避免重复触发
        confirmedSnapshots.set(n, takeSnapshot(n));
      } else if (curText.length >= confirmed.text.length) {
        // 内容没减少，更新确认快照
        confirmedSnapshots.set(n, takeSnapshot(n));
      }
    }
  }

  // 节点删除：延迟确认
  const pendingRemovals = new Map(); // key=hash(text) -> { snap, timer, parentNode, nextSibling }

  function handleRemovedNode(node, parent, nextSibling) {
    // 流式期间忽略删除（React 重渲染导致的大量删除）
    if (isStreaming) return;

    // 找到该节点对应的"确认快照"
    let snap = confirmedSnapshots.get(node);
    if (!snap) {
      // 节点本身不是快照目标，检查其内部是否含快照内容
      const inner = collectAIContentNodesIn(node);
      if (inner.length === 0) return;
      snap = confirmedSnapshots.get(inner[0]) || takeSnapshot(inner[0]);
      if (!snap.text || snap.text.length < SENSITIVITY.minSnapshotLen) return;
    }
    if (snap.text.length < SENSITIVITY.minSnapshotLen) return;

    const key = hashStr(snap.text);
    // 已有相同内容待确认 → 跳过
    if (pendingRemovals.has(key)) return;

    debug("节点删除待确认", { textLen: snap.text.length, delay: SENSITIVITY.removeDelay });
    // v1.0.3：延迟时间改为可配置（严格 800ms / 平衡 600ms / 激进 400ms）
    const timer = setTimeout(() => {
      pendingRemovals.delete(key);
      // 确认：检查页面是否仍有高度相似的内容（重渲染后新节点已就位）
      if (pageStillHasSimilarContent(snap.text)) {
        // 重渲染，非撤回，丢弃
        debug("删除待确认被取消（页面仍有相似内容，判定为重渲染）", { textLen: snap.text.length });
        return;
      }
      debug("确认节点删除撤回", { textLen: snap.text.length });
      // 确认撤回
      if (addRecord("remove", snap)) {
        insertRestoreBlock(parent, nextSibling, snap, "节点被删除");
      }
    }, SENSITIVITY.removeDelay);
    pendingRemovals.set(key, { snap, timer });
  }

  // 检查页面是否仍有高度相似内容（用于判断是否为重渲染而非撤回）
  // 返回 true  = 页面仍有相似内容 = 重渲染 = 不记录撤回
  // 返回 false = 页面无相似内容 = 真实撤回 = 记录
  // v1.0.3：前缀+后缀双校验 + 可配置长度阈值 + 最短文本要求，降低前缀碰撞漏报与重渲染误报
  function pageStillHasSimilarContent(text) {
    if (!text) return false;
    const targetLen = text.length;
    // 短文本前缀易碰撞（如"好的"、"根据您的问题"），无法可靠判定相似性
    // 严格模式下倾向不记录短文本撤回（返回 true 视为重渲染）
    if (targetLen < SENSITIVITY.minSimilarityLen) {
      return true;
    }
    const nodes = collectAIContentNodes(true);
    const ratio = SENSITIVITY.similarityRatio;
    const prefixLen = SENSITIVITY.similarityPrefix;
    const suffixLen = SENSITIVITY.similaritySuffix;
    for (const n of nodes) {
      const cur = (n.textContent || "").trim();
      // 长度阈值校验（严格 98% / 平衡 95% / 激进 90%）
      if (cur.length < targetLen * ratio) continue;
      // 前缀校验（严格 80 字符）
      if (cur.slice(0, prefixLen) !== text.slice(0, prefixLen)) continue;
      // 后缀校验（v1.0.3 新增）：避免开头相同但结尾被篡改的内容被误判为重渲染
      if (suffixLen > 0 && cur.length >= suffixLen && targetLen >= suffixLen) {
        if (cur.slice(-suffixLen) !== text.slice(-suffixLen)) continue;
      }
      return true;
    }
    return false;
  }

  // 新增节点：可能取消待确认的删除（重渲染场景）
  function handleAddedNode(node) {
    if (pendingRemovals.size === 0) return;
    const inner = isContentLike(node) ? [node] : collectAIContentNodesIn(node);
    for (const n of inner) {
      const cur = (n.textContent || "").trim();
      if (cur.length < 10) continue;
      const key = hashStr(cur);
      const pending = pendingRemovals.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRemovals.delete(key);
      }
    }
  }

  // 检查节点或其祖先链是否处于隐藏状态（v1.0.3 新增）
  function isHiddenOrAncestorHidden(node) {
    if (!node || !node.isConnected) return true;
    let p = node;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (cs.display === "none" || cs.visibility === "hidden" || p.hidden || p.getAttribute("aria-hidden") === "true") {
        return true;
      }
      p = p.parentElement;
    }
    return false;
  }

  // 检查页面"可见"位置是否仍有相似内容（v1.0.3 新增，handleHide 专用）
  // 与 pageStillHasSimilarContent 区别：跳过被隐藏的节点，避免被隐藏节点自身被误匹配
  function pageHasVisibleSimilarContent(text) {
    if (!text) return false;
    const targetLen = text.length;
    if (targetLen < SENSITIVITY.minSimilarityLen) {
      return true;
    }
    const nodes = collectAIContentNodes(true);
    const ratio = SENSITIVITY.similarityRatio;
    const prefixLen = SENSITIVITY.similarityPrefix;
    const suffixLen = SENSITIVITY.similaritySuffix;
    for (const n of nodes) {
      // 跳过被隐藏的节点（包括祖先隐藏）
      if (isHiddenOrAncestorHidden(n)) continue;
      const cur = (n.textContent || "").trim();
      if (cur.length < targetLen * ratio) continue;
      if (cur.slice(0, prefixLen) !== text.slice(0, prefixLen)) continue;
      if (suffixLen > 0 && cur.length >= suffixLen && targetLen >= suffixLen) {
        if (cur.slice(-suffixLen) !== text.slice(-suffixLen)) continue;
      }
      return true;
    }
    return false;
  }

  // 判断节点是否为根容器级别（v1.0.3 新增）
  // 用于排除切换标签页/路由/模态框遮罩导致的整片隐藏误报
  function isRootContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el === document.body || el === document.documentElement) return true;
    if (el.tagName === "MAIN") return true;
    for (const sel of SITE.rootSelectors) {
      try { if (el.matches && el.matches(sel)) return true; } catch (e) {}
    }
    return false;
  }

  // 隐藏判定
  // v1.0.3：增加延迟确认 + 恢复可见取消 + 可见相似度二次校验 + 根容器整片隐藏排除
  // 大幅降低折叠展开、切换深浅色主题、虚拟列表滚动、模态框 aria-hidden 临时变化等导致的误报
  const pendingHides = new Map(); // key=hash(text) -> { snap, timer, cn }
  function handleHide(el) {
    if (isStreaming) return;
    // v1.0.3：根容器级别的整片隐藏（切换标签页/路由/模态框遮罩）视为 UI 切换，非撤回
    if (isRootContainer(el)) {
      debug("忽略根容器整片隐藏（UI 切换，非撤回）", { tag: el.tagName });
      return;
    }
    const hidden =
      getComputedStyle(el).display === "none" ||
      getComputedStyle(el).visibility === "hidden" ||
      el.hidden ||
      el.getAttribute("aria-hidden") === "true";
    if (!hidden) return;
    const contentNodes = collectAIContentNodesIn(el);
    for (const cn of contentNodes) {
      const snap = confirmedSnapshots.get(cn);
      if (!snap || snap.text.length < SENSITIVITY.minSnapshotLen) continue;
      const key = hashStr(snap.text);
      if (pendingHides.has(key)) continue;
      debug("隐藏待确认", { textLen: snap.text.length, delay: SENSITIVITY.hideDelay });
      const timer = setTimeout(() => {
        pendingHides.delete(key);
        // 校验1：节点是否已被移除（属于删除而非隐藏，交由 handleRemovedNode 处理）
        if (!cn.isConnected) {
          debug("隐藏待确认被取消（节点已移除，转由删除判定处理）", { textLen: snap.text.length });
          return;
        }
        // 校验2：节点是否已恢复可见（折叠展开、主题切换回切、模态框关闭等）
        if (!isHiddenOrAncestorHidden(cn)) {
          debug("隐藏待确认被取消（节点已恢复可见）", { textLen: snap.text.length });
          return;
        }
        // 校验3：可见位置相似度二次校验（页面其他可见位置仍有内容视为重渲染/复制）
        if (SENSITIVITY.hideRequireSimilarCheck && pageHasVisibleSimilarContent(snap.text)) {
          debug("隐藏待确认被取消（可见位置仍有相似内容）", { textLen: snap.text.length });
          return;
        }
        debug("确认节点隐藏撤回", { textLen: snap.text.length });
        addRecord("hide", snap);
      }, SENSITIVITY.hideDelay);
      pendingHides.set(key, { snap, timer, cn });
    }
  }

  // ============================================================
  // 记录存储（内存）
  // ============================================================
  function addRecord(reason, snapshot, extra) {
    if (!snapshot || (!snapshot.text && !snapshot.html)) return false;
    const text = snapshot.text || "";
    if (text.length < SENSITIVITY.minSnapshotLen) return false;
    const id = hashStr(text) + "_" + snapshot.ts;
    const now = Date.now();
    // v1.0.3：去重窗口可配置（严格 8s / 平衡 5s / 激进 3s），降低短时间重复误报
    if (STORE.records.some((r) => r.id === id && now - r.capturedAt < SENSITIVITY.dedupWindow)) {
      debug("记录被去重过滤", { id, reason });
      return false;
    }
    const record = {
      id,
      site: SITE.name,
      url: location.href.split("#")[0],
      reason,
      text,
      html: snapshot.html,
      timestamp: snapshot.ts,
      capturedAt: now,
      preview: truncate(text, 120)
    };
    STORE.records.unshift(record);
    if (STORE.records.length > 500) STORE.records.length = 500;
    debug("新增撤回记录", { reason, textLen: text.length, preview: truncate(text, 60) });
    onNewRecord(record);
    return true;
  }

  // ============================================================
  // 原位恢复
  // ============================================================
  function insertRestoreBlock(parentNode, nextSibling, snapshot, reason) {
    if (!parentNode || !snapshot) return;
    const dark = isDarkMode();
    const block = document.createElement("div");
    block.className = "aisaver-restore-block" + (dark ? " aisaver-dark" : "");
    block.setAttribute("data-aisaver", "1");
    block.innerHTML = `
      <div class="aisaver-restore-tag">⚠ 已撤回 · ${escapeHtml(reason)}</div>
      <div class="aisaver-restore-meta">${escapeHtml(SITE.name)} · ${formatTime(snapshot.ts)}</div>
      <div class="aisaver-restore-content">${snapshot.html ? sanitizeHtml(snapshot.html) : escapeHtml(snapshot.text)}</div>
      <div class="aisaver-restore-actions">
        <a data-act="copy">复制文本</a>
        <a data-act="locate">定位记录</a>
      </div>`;
    block.querySelector('[data-act="copy"]').addEventListener("click", (e) => {
      e.preventDefault();
      navigator.clipboard && navigator.clipboard.writeText(snapshot.text).then(() => showToast("已复制到剪贴板")).catch(console.error);
    });
    block.querySelector('[data-act="locate"]').addEventListener("click", (e) => {
      e.preventDefault();
      openPanel();
    });
    try {
      if (nextSibling && nextSibling.parentNode === parentNode) {
        parentNode.insertBefore(block, nextSibling);
      } else {
        parentNode.appendChild(block);
      }
    } catch (e) {}
  }

  // ============================================================
  // Toast / UI
  // ============================================================
  // ============================================================
  // 内联样式（与扩展版 content.css 一致）
  // ============================================================
  const AISAVER_CSS = `
/* AI撤回保存器样式 - 书签版内联 */
.aisaver-restore-block {
  position: relative;
  margin: 12px 0;
  padding: 14px 16px 14px 18px;
  border: 1px dashed #e85d5d;
  border-left: 4px solid #e85d5d;
  border-radius: 8px;
  background: linear-gradient(90deg, rgba(232, 93, 93, 0.06), rgba(255, 255, 255, 0.55));
  font-size: 14px;
  line-height: 1.7;
  color: #2b2b2b;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  animation: aisaver-fadein 0.25s ease;
}
.aisaver-restore-block.aisaver-dark {
  background: linear-gradient(90deg, rgba(232, 93, 93, 0.14), rgba(40, 40, 42, 0.9));
  color: #e8e8e8;
  border-color: #c05050;
}
.aisaver-restore-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  margin-bottom: 8px;
  font-size: 12px;
  font-weight: 600;
  color: #fff;
  background: #e85d5d;
  border-radius: 10px;
  user-select: none;
}
.aisaver-restore-meta {
  font-size: 11px;
  color: #999;
  margin-bottom: 6px;
}
.aisaver-restore-content {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow-y: auto;
  padding-right: 4px;
}
.aisaver-restore-content img,
.aisaver-restore-content video {
  max-width: 100%;
  border-radius: 6px;
}
.aisaver-restore-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
  font-size: 12px;
}
.aisaver-restore-actions a {
  color: #e85d5d;
  cursor: pointer;
  text-decoration: none;
  border-bottom: 1px dotted #e85d5d;
}
.aisaver-restore-actions a:hover { opacity: 0.8; }
@keyframes aisaver-fadein {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 侧边历史浮层 */
#aisaver-panel-root {
  position: fixed;
  top: 0;
  right: 0;
  width: 420px;
  height: 100vh;
  z-index: 2147483647;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
#aisaver-panel-root * { box-sizing: border-box; }
.aisaver-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 100%;
  height: 100%;
  background: #ffffff;
  box-shadow: -4px 0 24px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  pointer-events: auto;
  transform: translateX(100%);
  transition: transform 0.28s cubic-bezier(0.22, 0.61, 0.36, 1);
}
.aisaver-panel.aisaver-open { transform: translateX(0); }
.aisaver-panel.aisaver-dark { background: #1f1f23; color: #e8e8e8; }
.aisaver-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid #eee;
  background: #e85d5d;
  color: #fff;
}
.aisaver-panel.aisaver-dark .aisaver-panel-header { border-bottom-color: #333; }
.aisaver-panel-title {
  font-size: 15px;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 6px;
}
.aisaver-panel-count {
  background: rgba(255, 255, 255, 0.25);
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 12px;
}
.aisaver-panel-close {
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  background: transparent;
  border: none;
  color: #fff;
}
.aisaver-panel-close:hover { background: rgba(255, 255, 255, 0.2); }
.aisaver-panel-toolbar {
  display: flex;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid #f0f0f0;
  font-size: 12px;
}
.aisaver-panel.aisaver-dark .aisaver-panel-toolbar { border-bottom-color: #333; }
.aisaver-panel-toolbar button {
  padding: 4px 10px;
  border: 1px solid #ddd;
  border-radius: 4px;
  background: #fafafa;
  cursor: pointer;
  font-size: 12px;
  color: #555;
}
.aisaver-panel.aisaver-dark .aisaver-panel-toolbar button {
  background: #2a2a2e;
  border-color: #444;
  color: #ccc;
}
.aisaver-panel-toolbar button:hover {
  background: #e85d5d;
  color: #fff;
  border-color: #e85d5d;
}
.aisaver-panel-list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 16px;
}
.aisaver-empty {
  text-align: center;
  color: #aaa;
  padding: 48px 16px;
  font-size: 13px;
}
.aisaver-item {
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
  background: #fafafa;
  font-size: 13px;
  line-height: 1.6;
}
.aisaver-panel.aisaver-dark .aisaver-item {
  background: #2a2a2e;
  border-color: #383838;
}
.aisaver-item-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.aisaver-item-site { font-size: 11px; font-weight: 600; color: #e85d5d; }
.aisaver-item-time { font-size: 11px; color: #aaa; }
.aisaver-item-reason {
  font-size: 11px;
  color: #e85d5d;
  margin-bottom: 6px;
  background: rgba(232, 93, 93, 0.08);
  padding: 2px 6px;
  border-radius: 4px;
  display: inline-block;
}
.aisaver-item-text {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 160px;
  overflow-y: auto;
  color: #444;
}
.aisaver-panel.aisaver-dark .aisaver-item-text { color: #ccc; }
.aisaver-item-actions {
  margin-top: 6px;
  display: flex;
  gap: 10px;
  font-size: 12px;
}
.aisaver-item-actions a {
  color: #e85d5d;
  cursor: pointer;
  text-decoration: none;
}
.aisaver-item-actions a:hover { text-decoration: underline; }

/* 悬浮按钮 FAB */
#aisaver-fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: #e85d5d;
  color: #fff;
  border: none;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(232, 93, 93, 0.45);
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  transition: transform 0.2s;
}
#aisaver-fab:hover { transform: scale(1.08); }
.aisaver-fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: #ff3b30;
  color: #fff;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  border: 2px solid #fff;
}

/* Toast 通知 */
.aisaver-toast {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(232, 93, 93, 0.96);
  color: #fff;
  padding: 8px 18px;
  border-radius: 20px;
  font-size: 13px;
  z-index: 2147483647;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  animation: aisaver-fadein 0.2s ease;
}
`;

  // 注入样式（仅一次）
  function injectStyles() {
    if (document.getElementById("aisaver-styles")) return;
    const style = document.createElement("style");
    style.id = "aisaver-styles";
    style.textContent = AISAVER_CSS;
    document.head.appendChild(style);
  }

  function showToast(msg) {
    const old = $(".aisaver-toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.className = "aisaver-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  let fab, panelRoot, panelEl, listEl, badgeEl, panelOpen = false;

  // v1.0.5：书签版初始化诊断 Toast（延迟 500ms 确保 DOM 已渲染）
  function showInitDiagnostic(nodeCount) {
    const msg = nodeCount > 0
      ? `🛡 AI撤回保存器已就绪，检测到 ${nodeCount} 个 AI 消息节点`
      : `⚠ AI撤回保存器已启动，但未检测到 AI 消息节点（可能站点类名已更新，请在控制台查看诊断信息）`;
    setTimeout(() => showToast(msg), 500);
  }

  function ensureUI() {
    if (fab) return;
    // v1.0.5: 注入内联样式
    injectStyles();
    // 悬浮按钮
    fab = document.createElement("button");
    fab.id = "aisaver-fab";
    fab.title = "AI撤回保存器 - 查看历史";
    fab.innerHTML = '🛡<span class="aisaver-fab-badge" style="display:none">0</span>';
    badgeEl = fab.querySelector(".aisaver-fab-badge");
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);
    // 面板
    panelRoot = document.createElement("div");
    panelRoot.id = "aisaver-panel-root";
    panelRoot.innerHTML = `
      <div class="aisaver-panel">
        <div class="aisaver-panel-header">
          <div class="aisaver-panel-title">🛡 AI撤回保存器 <span class="aisaver-panel-count">0</span></div>
          <button class="aisaver-panel-close" title="关闭">×</button>
        </div>
        <div class="aisaver-panel-toolbar">
          <button data-act="clear">清空记录</button>
          <button data-act="export">导出 JSON</button>
          <button data-act="refresh">刷新</button>
        </div>
        <div class="aisaver-panel-list"></div>
      </div>`;
    document.body.appendChild(panelRoot);
    panelEl = panelRoot.querySelector(".aisaver-panel");
    listEl = panelRoot.querySelector(".aisaver-panel-list");
    panelEl.querySelector(".aisaver-panel-close").addEventListener("click", () => openPanel(false));
    panelEl.querySelector('[data-act="clear"]').addEventListener("click", () => {
      if (confirm("确定清空当前页面的所有撤回记录？（仅清空内存，不可恢复）")) {
        STORE.records.length = 0;
        renderList();
        updateBadge();
        showToast("已清空");
      }
    });
    panelEl.querySelector('[data-act="export"]').addEventListener("click", exportRecords);
    panelEl.querySelector('[data-act="refresh"]').addEventListener("click", renderList);
    applyDark();
  }

  function applyDark() {
    if (!panelEl) return;
    panelEl.classList.toggle("aisaver-dark", isDarkMode());
  }

  function openPanel(open) {
    ensureUI();
    panelOpen = open !== undefined ? open : !panelOpen;
    panelEl.classList.toggle("aisaver-open", panelOpen);
    if (panelOpen) renderList();
  }
  function togglePanel() { openPanel(!panelOpen); }

  function renderList() {
    if (!listEl) return;
    applyDark();
    panelRoot.querySelector(".aisaver-panel-count").textContent = STORE.records.length;
    updateBadge();
    if (STORE.records.length === 0) {
      listEl.innerHTML = `<div class="aisaver-empty">暂无撤回记录<br><span style="font-size:12px;color:#bbb">当 AI 回复被撤回/重新生成/删除时，会自动保存在这里</span></div>`;
      return;
    }
    listEl.innerHTML = STORE.records.map((r) => `
      <div class="aisaver-item" data-id="${r.id}">
        <div class="aisaver-item-head">
          <span class="aisaver-item-site">${escapeHtml(r.site)}</span>
          <span class="aisaver-item-time">${formatTime(r.timestamp)}</span>
        </div>
        <span class="aisaver-item-reason">${escapeHtml(reasonLabel(r.reason))}</span>
        <div class="aisaver-item-text">${escapeHtml(truncate(r.text, 600))}</div>
        <div class="aisaver-item-actions">
          <a data-act="copy">复制</a>
          <a data-act="full">查看全文</a>
          <a data-act="html">查看HTML</a>
        </div>
      </div>`).join("");
    listEl.querySelectorAll(".aisaver-item").forEach((item) => {
      const id = item.getAttribute("data-id");
      const r = STORE.records.find((x) => x.id === id);
      if (!r) return;
      item.querySelector('[data-act="copy"]').addEventListener("click", (e) => {
        e.preventDefault();
        navigator.clipboard && navigator.clipboard.writeText(r.text).then(() => showToast("已复制")).catch(console.error);
      });
      item.querySelector('[data-act="full"]').addEventListener("click", (e) => {
        e.preventDefault();
        showFullText(r);
      });
      item.querySelector('[data-act="html"]').addEventListener("click", (e) => {
        e.preventDefault();
        showFullText(r, true);
      });
    });
  }

  function reasonLabel(reason) {
    return ({ remove: "节点被删除", replace: "内容被覆盖/清空", hide: "节点被隐藏", regenerate: "重新生成覆盖" })[reason] || reason;
  }

  function showFullText(r, asHtml) {
    const dark = isDarkMode();
    const overlay = document.createElement("div");
    overlay.setAttribute("data-aisaver", "1");
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;";
    const box = document.createElement("div");
    box.style.cssText = `max-width:760px;width:100%;max-height:80vh;overflow:auto;border-radius:10px;padding:20px;background:${dark ? "#2a2a2e" : "#fff"};color:${dark ? "#eee" : "#222"};box-shadow:0 8px 32px rgba(0,0,0,.3);`;
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><b>${escapeHtml(r.site)} · ${reasonLabel(r.reason)}</b><a style="cursor:pointer;color:#e85d5d">关闭</a></div>`;
    const body = document.createElement("div");
    body.style.cssText = "white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.7";
    if (asHtml) body.innerHTML = sanitizeHtml(r.html); else body.textContent = r.text;
    box.appendChild(body);
    box.querySelector("a").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  function exportRecords() {
    const data = JSON.stringify(STORE.records, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ai-recall-${SITE.name}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("已导出 JSON");
  }

  function updateBadge() {
    const n = STORE.records.length;
    if (badgeEl) {
      badgeEl.textContent = n > 99 ? "99+" : n;
      badgeEl.style.display = n > 0 ? "" : "none";
    }
    // 书签版无 chrome.runtime，不发消息
  }

  function onNewRecord(record) {
    ensureUI();
    renderList();
    showToast(`捕获到一条撤回消息（${reasonLabel(record.reason)}）`);
  }

  // ============================================================
  // DeepSeek SSE 监听：直接从 completion 请求提取回复
  // ============================================================
  // v1.0.5: 针对 DeepSeek 添加 SSE 监听，从 completion 请求的响应中直接提取 AI 回复
  // 监听 EventSource 消息，解析 data 中的 content 字段
  function setupDeepSeekSSEListener() {
    if (location.hostname !== 'chat.deepseek.com') return;

    const originalEventSource = window.EventSource;
    if (!originalEventSource) return;

    window.EventSource = function(url, options) {
      const es = new originalEventSource(url, options);

      // 检查是否是 completion 相关的 SSE
      if (url && url.indexOf('completion') !== -1) {
        debug('DeepSeek SSE: 监听到 completion 请求', url);

        let currentMessageId = null;
        let accumulatedContent = '';
        let thinkingContent = '';
        let responseStarted = false;

        es.addEventListener('message', function(event) {
          try {
            const data = JSON.parse(event.data);

            // 处理 ready 事件，获取 message_id
            if (data.request_message_id && data.response_message_id) {
              currentMessageId = data.response_message_id;
              debug('DeepSeek SSE: ready', data);
              return;
            }

            // 处理响应片段 (v 字段包含 content)
            if (data.v) {
              // 检查是否是 fragments 更新
              if (data.v.response && data.v.response.fragments) {
                const fragments = data.v.response.fragments;
                for (let i = 0; i < fragments.length; i++) {
                  const frag = fragments[i];
                  if (frag.type === 'THINK' && frag.content) {
                    thinkingContent += frag.content;
                  } else if (frag.type === 'RESPONSE' && frag.content) {
                    accumulatedContent += frag.content;
                    responseStarted = true;
                  }
                }
                debug('DeepSeek SSE: fragments update', { thinking: thinkingContent.length, response: accumulatedContent.length });
              }

              // 处理 p 字段的路径更新 (如 response/fragments/-1/content)
              if (data.p && data.o && data.v !== undefined) {
                if (data.p.indexOf('response/fragments/-1/content') !== -1 ||
                    data.p.indexOf('fragments/-1/content') !== -1) {
                  if (data.o === 'APPEND' || data.o === 'SET') {
                    accumulatedContent += data.v;
                    responseStarted = true;
                  }
                }
                debug('DeepSeek SSE: path update', data);
              }

              // 处理独立的 v 字段 (流式字符)
              if (typeof data.v === 'string' && !data.p) {
                accumulatedContent += data.v;
                responseStarted = true;
              }
            }

            // 检测响应结束
            if (data.p === 'response/status' && data.v === 'FINISHED') {
              debug('DeepSeek SSE: 响应完成', { content: accumulatedContent.substring(0, 100) });
              if (accumulatedContent.trim().length > 0) {
                const snap = {
                  text: accumulatedContent.trim(),
                  html: escapeHtml(accumulatedContent),
                  ts: Date.now(),
                  source: 'deepseek-sse'
                };

                // 检查是否已经有相同内容（避免重复）
                const lastRecord = STORE.records[STORE.records.length - 1];
                if (!lastRecord || lastRecord.text !== snap.text) {
                  addRecord('replace', snap);
                  debug('DeepSeek SSE: 已记录撤回', snap.text.substring(0, 50));
                }
              }
              // 重置状态
              accumulatedContent = '';
              thinkingContent = '';
              responseStarted = false;
              currentMessageId = null;
            }

          } catch (e) {
            // JSON 解析失败，忽略
          }
        }, false);

        es.addEventListener('update_session', function(event) {
          debug('DeepSeek SSE: update_session', event.data);
        }, false);

        es.addEventListener('title', function(event) {
          debug('DeepSeek SSE: title', event.data);
        }, false);

        es.addEventListener('close', function(event) {
          debug('DeepSeek SSE: close', event.data);
          // 连接关闭时，如果还有未保存的内容，也记录下来
          if (accumulatedContent.trim().length > 0 && responseStarted) {
            const snap = {
              text: accumulatedContent.trim(),
              html: escapeHtml(accumulatedContent),
              ts: Date.now(),
              source: 'deepseek-sse-close'
            };
            const lastRecord = STORE.records[STORE.records.length - 1];
            if (!lastRecord || lastRecord.text !== snap.text) {
              addRecord('replace', snap);
            }
            accumulatedContent = '';
            responseStarted = false;
          }
        }, false);
      }

      return es;
    };

    // 保持原始原型链
    window.EventSource.prototype = originalEventSource.prototype;
  }

  // ============================================================
  // MutationObserver（批处理 + 降级监听）
  // ============================================================
  // 收集 mutations，批量处理
  let pendingMutations = [];
  let processingScheduled = false;

  function scheduleProcess() {
    if (processingScheduled) return;
    processingScheduled = true;
    setTimeout(processPendingMutations, 300);
  }

  function processPendingMutations() {
    processingScheduled = false;
    const muts = pendingMutations;
    pendingMutations = [];
    if (muts.length === 0) return;

    // 1. 流式检测（每次都做，轻量）
    detectStreaming();

    // 2. 流式期间不进行撤回判定
    if (isStreaming) return;

    // 3. 处理删除/新增/隐藏
    for (const m of muts) {
      if (m.type === "childList") {
        if (m.removedNodes && m.removedNodes.length) {
          for (const node of m.removedNodes) {
            if (node.nodeType !== 1 || shouldExclude(node)) continue;
            handleRemovedNode(node, m.target, m.nextSibling);
          }
        }
        if (m.addedNodes && m.addedNodes.length) {
          for (const node of m.addedNodes) {
            if (node.nodeType !== 1 || shouldExclude(node)) continue;
            handleAddedNode(node);
          }
        }
      } else if (m.type === "attributes" && m.attributeName) {
        if (m.attributeName === "style" || m.attributeName === "class" || m.attributeName === "hidden" || m.attributeName === "aria-hidden") {
          if (m.target && m.target.nodeType === 1 && !shouldExclude(m.target)) handleHide(m.target);
        }
      }
    }

    // 4. 内容覆盖检测（非流式时）
    checkContentRecall();

    // 5. 刷新缓存（DOM 已变化）
    cachedContentNodes = null;

    // 6. 重新绑定重新生成按钮
    bindRegenerateButtons();
  }

  let observer = null;
  function observeRoot() {
    if (observer) { try { observer.disconnect(); } catch (e) {} }
    let root = null;
    for (const sel of SITE.rootSelectors) {
      try { root = $(sel); } catch (e) { continue; }
      if (root) break;
    }
    if (!root) root = document.body;
    observer = new MutationObserver((muts) => {
      pendingMutations = pendingMutations.concat(muts);
      scheduleProcess();
    });
    // 降级监听：去掉 characterData，只保留 childList + 关键 attributes
    // characterData 在流式输出时每字符触发一次，是性能杀手
    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-hidden"]
    });
  }

  // ============================================================
  // 重新生成按钮监听
  // ============================================================
  function bindRegenerateButtons() {
    for (const sel of SITE.regenerateSelectors) {
      let btns = [];
      try { btns = $$(sel); } catch (e) { continue; }
      for (const btn of btns) {
        if (btn.__aisaverBound) continue;
        btn.__aisaverBound = true;
        btn.addEventListener("pointerdown", onRegenerateClick, true);
      }
    }
  }

  function onRegenerateClick() {
    const nodes = collectAIContentNodes(true);
    if (nodes.length === 0) return;
    const last = nodes[nodes.length - 1];
    const snap = confirmedSnapshots.get(last) || streamingSnapshots.get(last) || takeSnapshot(last);
    if (snap.text && snap.text.length > 3) {
      addRecord("regenerate", snap);
    }
  }

  // ============================================================
  // 通信
  // ============================================================
  // 书签版：移除 chrome.runtime 通信

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    // v1.0.3：先加载灵敏度配置（异步），再初始化监听
    loadConfig();
    // v1.0.5: DeepSeek SSE 监听优先启动
    setupDeepSeekSSEListener();
    ensureUI();
    observeRoot();
    // 初始确认快照
    const nodes = collectAIContentNodes(true);
    for (const n of nodes) confirmedSnapshots.set(n, takeSnapshot(n));
    lastTotalLength = nodes.reduce((s, n) => s + (n.textContent || "").trim().length, 0);
    bindRegenerateButtons();
    updateBadge();
    // v1.0.5：初始化诊断 Toast
    showInitDiagnostic(nodes.length);
    if (DEBUG_MODE) {
      debug("站点配置:", JSON.stringify({
        name: SITE.name,
        hostname: location.hostname,
        contentSelectors: SITE.contentSelectors,
        messageSelectors: SITE.messageSelectors,
        assistantHints: SITE.assistantHints,
        excludeSelectors: SITE.excludeSelectors.slice(0, 5),
        detectedNodes: nodes.length
      }, null, 2));
    }
    // 定时刷新确认快照（兜底，确保非流式状态也有最新快照）
    setInterval(() => {
      if (!isStreaming) {
        const ns = collectAIContentNodes(true);
        let len = 0;
        for (const n of ns) {
          len += (n.textContent || "").trim().length;
          // 只更新更长或相等的，避免覆盖
          const prev = confirmedSnapshots.get(n);
          const cur = takeSnapshot(n);
          if (!prev || cur.text.length >= prev.text.length) {
            confirmedSnapshots.set(n, cur);
          }
        }
        lastTotalLength = len;
      }
    }, 3000);
    // SPA 路由切换后重新挂载
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        cachedContentNodes = null;
        setTimeout(observeRoot, 600);
      }
    }, 1000);
    console.log(`[AI撤回保存器 v1.0.5] 已在 ${SITE.name} (${location.hostname}) 启动。（书签版）灵敏度: ${SENSITIVITY.name}，调试: ${DEBUG_MODE ? "开" : "关"}。检测到 ${nodes.length} 个 AI 内容节点。`);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(init, 300);
  } else {
    window.addEventListener("DOMContentLoaded", () => setTimeout(init, 300));
  }
})();
