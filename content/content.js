/**
 * AI撤回保存器 - 核心内容脚本 (v1.0.3 严格识别版)
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
 * v1.0.3 修复要点（解决「记录与对话无关的更新」）：
 *  1. 已知站点不再合并 FALLBACK 宽泛选择器，避免侧边栏/欢迎语等被误识别
 *  2. looksLikeAssistantContent 严格化：必须在 assistant 消息项内，或
 *     （markdown 内容类 且 在对话根容器内）；最小文本长度 5 → 20
 *  3. handleRemovedNode 仅处理「已确认快照」节点被删除，不再现拍快照兜底
 *  4. 关闭隐藏型撤回（display:none / aria-hidden 误报率极高），observer 去掉 attributes 监听
 *  5. checkContentRecall 增加「当前内容极短 <30」阈值，避免展开/折叠、tab 切换误判
 *  6. collectAIContentNodesIn 去掉「root 文本 > 30 即视为内容」的危险兜底
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
  // 严格识别辅助：对话根容器 + assistant 消息项
  // ============================================================
  // 仅保留“具体”的根选择器（排除 main/body/[role=main]/html），
  // 用于判断节点是否位于对话主容器内，避免侧边栏/欢迎语等被纳入监控。
  const GENERIC_ROOT = new Set(["main", "body", "html", "[role='main']", "[role=main]"]);
  const concreteRootSelectors = (SITE.rootSelectors || []).filter(
    (s) => !GENERIC_ROOT.has(String(s).trim())
  );

  function isInsideConversationRoot(node) {
    if (!node || node.nodeType !== 1) return false;
    if (concreteRootSelectors.length === 0) return false;
    for (const sel of concreteRootSelectors) {
      try {
        if (node.closest && node.closest(sel)) return true;
      } catch (e) {}
    }
    return false;
  }

  // 判断节点是否位于“assistant 消息项”内：
  // 向上查找 messageSelectors 匹配的祖先，并检查其 className 是否含 assistantHints。
  // 命中消息项但无 assistant 标识 → 视为用户消息，返回 false。
  function isInsideAssistantMessage(node) {
    if (!node || node.nodeType !== 1) return false;
    if (!SITE.messageSelectors || SITE.messageSelectors.length === 0) return false;
    let el = node.parentElement;
    let depth = 0;
    while (el && el !== document.body && depth < 30) {
      let isMsg = false;
      for (const sel of SITE.messageSelectors) {
        try { if (el.matches && el.matches(sel)) { isMsg = true; break; } } catch (e) {}
      }
      if (isMsg) {
        const cls = (el.className && el.className.toString().toLowerCase()) || "";
        for (const h of SITE.assistantHints) {
          if (h && cls.indexOf(h.toLowerCase()) >= 0) return true;
        }
        return false;
      }
      el = el.parentElement;
      depth++;
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
          // 回退路径同样需要严格校验，避免把消息项内任意文本块当作 AI 内容
          if (inner && !seen.has(inner) && looksLikeAssistantContent(inner)) {
            seen.add(inner);
            out.push(inner);
          }
        }
      }
    }
    cachedContentNodes = out;
    cacheInvalidAt = now + 800;
    return out;
  }

  function looksLikeAssistantContent(node) {
    if (!node || node.nodeType !== 1) return false;
    const text = (node.textContent || "").trim();
    if (text.length < 20) return false; // 提高最小长度，过滤短文本/标签/按钮
    const tag = node.tagName;
    if (tag === "TEXTAREA" || tag === "INPUT") return false;
    if (node.isContentEditable) return false;
    if (shouldExclude(node)) return false;
    // 严格判定：必须在 assistant 消息项内，或（是 markdown 内容类 且 在对话根容器内）。
    // 旧逻辑仅判断文本长度 > 5，几乎任何文本块都被视为 AI 回复，是误记录的根源。
    if (isInsideAssistantMessage(node)) return true;
    if (isContentLike(node) && isInsideConversationRoot(node)) return true;
    return false;
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
    // 注意：不再将 root 本身作为兜底内容节点。
    // 旧逻辑「root 文本 > 30 即视为内容」会把任意被删除/隐藏的文本块（菜单、弹窗、
    // 折叠面板等）误判为 AI 回复，是误记录的主要来源之一。
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
  function checkContentRecall() {
    if (isStreaming) return;
    const nodes = collectAIContentNodes();
    for (const n of nodes) {
      const confirmed = confirmedSnapshots.get(n);
      if (!confirmed) continue;
      const curText = (n.textContent || "").trim();
      // 骤减判定：确认快照足够长，当前内容极短（<30 字符），且减少 >70%。
      // 增加「当前极短」阈值，避免展开/折叠、tab 切换等常规交互被误判为覆盖撤回。
      if (confirmed.text.length >= 20 && curText.length < 30 && curText.length < confirmed.text.length * 0.3) {
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

    // 只处理「已确认的 AI 内容节点」被删除：snap 必须来自 confirmedSnapshots，
    // 不再现拍快照（否则任意含文本的节点删除都会被误记为撤回）。
    let snap = confirmedSnapshots.get(node);
    let target = node;
    if (!snap) {
      // 节点本身不是快照目标，检查其内部是否含「已确认」的 AI 内容节点
      const inner = collectAIContentNodesIn(node);
      if (inner.length === 0) return;
      for (const cn of inner) {
        const s = confirmedSnapshots.get(cn);
        if (s && s.text.length >= 20) { snap = s; target = cn; break; }
      }
      if (!snap) return; // 内部没有已确认快照 → 不是 AI 回复，忽略
    }
    if (snap.text.length < 20) return;

    // 双重保险：被删除内容必须位于对话主容器或 assistant 消息项内
    if (!isInsideConversationRoot(target) && !isInsideAssistantMessage(target)) return;

    const key = hashStr(snap.text);
    // 已有相同内容待确认 → 跳过
    if (pendingRemovals.has(key)) return;

    // 延迟 600ms 确认：若期间原位置出现等价内容(重渲染)，则取消
    const timer = setTimeout(() => {
      pendingRemovals.delete(key);
      // 确认：检查页面是否仍有高度相似的内容（重渲染后新节点已就位）
      if (pageStillHasSimilarContent(snap.text)) {
        // 重渲染，非撤回，丢弃
        return;
      }
      // 确认撤回
      if (addRecord("remove", snap)) {
        insertRestoreBlock(parent, nextSibling, snap, "节点被删除");
      }
    }, 600);
    pendingRemovals.set(key, { snap, timer });
  }

  // 检查页面是否仍有高度相似内容（用于判断是否为重渲染而非撤回）
  function pageStillHasSimilarContent(text) {
    const nodes = collectAIContentNodes(true);
    const targetLen = text.length;
    for (const n of nodes) {
      const cur = (n.textContent || "").trim();
      // 长度相近且前缀匹配（重渲染内容基本一致）
      if (cur.length >= targetLen * 0.85 && cur.slice(0, 50) === text.slice(0, 50)) {
        return true;
      }
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

  // 隐藏判定（默认关闭）
  // 弹窗折叠、tab 切换、菜单收起、loading 隐藏等都会触发 display:none / aria-hidden，
  // 误报率极高，因此默认不记录隐藏型撤回。
  // 如需启用：在站点配置中设置 enableHideRecall: true，并恢复 observer 的 attributes 监听
  // 与 processPendingMutations 中的 attributes 分支。
  function handleHide(el) {
    if (SITE.enableHideRecall !== true) return;
    if (isStreaming) return;
    const hidden =
      getComputedStyle(el).display === "none" ||
      getComputedStyle(el).visibility === "hidden" ||
      el.hidden ||
      el.getAttribute("aria-hidden") === "true";
    if (!hidden) return;
    const contentNodes = collectAIContentNodesIn(el);
    for (const cn of contentNodes) {
      const snap = confirmedSnapshots.get(cn);
      if (!snap || snap.text.length < 20) continue;
      addRecord("hide", snap);
    }
  }

  // ============================================================
  // 记录存储（内存）
  // ============================================================
  function addRecord(reason, snapshot, extra) {
    if (!snapshot || (!snapshot.text && !snapshot.html)) return false;
    const text = snapshot.text || "";
    if (text.length < 3) return false;
    const id = hashStr(text) + "_" + snapshot.ts;
    const now = Date.now();
    if (STORE.records.some((r) => r.id === id && now - r.capturedAt < 3000)) return false;
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

    // 3. 处理删除/新增（隐藏型撤回默认关闭，不再处理 attributes 变化）
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
    // 仅监听 childList：隐藏型撤回（display:none/aria-hidden）默认关闭，
    // 不再监听 attributes，避免 class/style 频繁变化带来的性能开销与误判。
    observer.observe(root, {
      childList: true,
      subtree: true
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
    console.log(`[AI撤回保存器 v1.0.3] 已在 ${SITE.name} (${location.hostname}) 启动。严格识别已启用，仅监控 AI 助手回复。`);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(init, 300);
  } else {
    window.addEventListener("DOMContentLoaded", () => setTimeout(init, 300));
  }
})();
