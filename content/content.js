/**
 * AI撤回保存器 - 核心内容脚本 (v1.0.3 降低误报率版)
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
 * 暴露 window.__AISaver__ 供 popup / 控制台调用。
 */
(function () {
  "use strict";

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

  // 从 chrome.storage 加载灵敏度与调试开关，并监听变化
  function loadConfig() {
    try {
      chrome.storage.local.get(["sensitivity", "debugMode"], (res) => {
        if (res.sensitivity && SENSITIVITY_PRESETS[res.sensitivity]) {
          SENSITIVITY = SENSITIVITY_PRESETS[res.sensitivity];
        }
        DEBUG_MODE = !!res.debugMode;
        debug("配置已加载", { sensitivity: SENSITIVITY.name, debug: DEBUG_MODE });
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.sensitivity && SENSITIVITY_PRESETS[changes.sensitivity.newValue]) {
          SENSITIVITY = SENSITIVITY_PRESETS[changes.sensitivity.newValue];
          debug("灵敏度切换为", SENSITIVITY.name);
        }
        if (changes.debugMode) {
          DEBUG_MODE = !!changes.debugMode.newValue;
          debug("调试模式", DEBUG_MODE ? "开启" : "关闭");
        }
      });
    } catch (e) {}
  }

  const SITE = window.AISaverSites
    ? window.AISaverSites.getSiteConfig(location.hostname)
    : {
        name: location.hostname,
        rootSelectors: ["main", "body"],
        messageSelectors: [],
        contentSelectors: [],
        assistantHints: [],
        regenerateSelectors: [],
        excludeSelectors: []
      };

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
      <div class="aisaver-restore-content">${snapshot.html || escapeHtml(snapshot.text)}</div>
      <div class="aisaver-restore-actions">
        <a data-act="copy">复制文本</a>
        <a data-act="locate">定位记录</a>
      </div>`;
    block.querySelector('[data-act="copy"]').addEventListener("click", (e) => {
      e.preventDefault();
      navigator.clipboard && navigator.clipboard.writeText(snapshot.text).then(() => showToast("已复制到剪贴板"));
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

  function ensureUI() {
    if (fab) return;
    fab = document.createElement("button");
    fab.id = "aisaver-fab";
    fab.title = "AI撤回保存器 - 查看历史";
    fab.innerHTML = "🛡<span class=\"aisaver-fab-badge\" style=\"display:none\">0</span>";
    badgeEl = fab.querySelector(".aisaver-fab-badge");
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);

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
        navigator.clipboard && navigator.clipboard.writeText(r.text).then(() => showToast("已复制"));
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
    if (asHtml) body.innerHTML = r.html; else body.textContent = r.text;
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
    try { chrome.runtime.sendMessage({ type: "UPDATE_BADGE", count: n }); } catch (e) {}
  }

  function onNewRecord(record) {
    ensureUI();
    renderList();
    showToast(`捕获到一条撤回消息（${reasonLabel(record.reason)}）`);
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
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "GET_RECORDS") {
        sendResponse({ records: STORE.records, site: SITE.name, url: location.href, streaming: isStreaming });
        return;
      }
      if (msg.type === "TOGGLE_PANEL") {
        ensureUI();
        openPanel(msg.open === undefined ? !panelOpen : msg.open);
        sendResponse({ open: panelOpen });
        return;
      }
      if (msg.type === "PING") {
        sendResponse({ ok: true, site: SITE.name, count: STORE.records.length, streaming: isStreaming });
        return;
      }
      if (msg.type === "CLEAR_RECORDS") {
        STORE.records.length = 0;
        renderList();
        updateBadge();
        sendResponse({ ok: true });
        return;
      }
      if (msg.type === "EXPORT_RECORDS") {
        exportRecords();
        sendResponse({ ok: true });
        return;
      }
    });
  } catch (e) {}

  // ============================================================
  // 初始化
  // ============================================================
  function init() {
    // v1.0.3：先加载灵敏度配置（异步），再初始化监听
    loadConfig();
    ensureUI();
    observeRoot();
    // 初始确认快照
    const nodes = collectAIContentNodes(true);
    for (const n of nodes) confirmedSnapshots.set(n, takeSnapshot(n));
    lastTotalLength = nodes.reduce((s, n) => s + (n.textContent || "").trim().length, 0);
    bindRegenerateButtons();
    updateBadge();
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
    try { chrome.runtime.sendMessage({ type: "CONTENT_READY", site: SITE.name }); } catch (e) {}
    console.log(`[AI撤回保存器 v1.0.3] 已在 ${SITE.name} (${location.hostname}) 启动。当前灵敏度: ${SENSITIVITY.name}，调试日志: ${DEBUG_MODE ? "开" : "关"}。`);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(init, 300);
  } else {
    window.addEventListener("DOMContentLoaded", () => setTimeout(init, 300));
  }
})();
