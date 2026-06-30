/**
 * AI撤回保存器 - 核心内容脚本
 *
 * 工作原理：
 *  1. 根据站点配置定位对话根容器，挂载 MutationObserver（childList + subtree +
 *     characterData + attributes），实现"全量监听"。
 *  2. 同时以 ~600ms 节流轮询所有识别到的 AI 消息内容节点，在 WeakMap 中维护
 *     "最近一次确认内容快照"——这是捕获"覆盖/清空"类撤回的关键
 *     （MutationObserver 不提供旧值，必须主动留存）。
 *  3. 撤回判定：
 *       - 节点被从 DOM 移除            → 删除型撤回
 *       - 文本长度骤减（>70% 且原长>20）→ 覆盖/清空型撤回
 *       - 节点被隐藏(display/hidden)    → 隐藏型撤回
 *       - 点击"重新生成"按钮            → 重新生成型撤回（覆盖前保存）
 *  4. 命中后：保留前一快照 → 原位插入恢复块 → 写入内存记录 → 通知 background 更新角标。
 *  5. 纯内存存储（window 变量），刷新页面后清空，保护隐私。
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
    : { name: location.hostname, rootSelectors: ["main", "body"], messageSelectors: [], contentSelectors: [], assistantHints: [], regenerateSelectors: [], excludeSelectors: [] };

  // ---------- 工具函数 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function debounce(fn, wait) {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), wait);
    };
  }

  // 简易字符串哈希（用于去重）
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

  // 判断节点是否应当被忽略（恢复块自身、输入框等）
  function shouldExclude(node) {
    if (!node || node.nodeType !== 1) return true;
    if (node.hasAttribute && node.hasAttribute("data-aisaver")) return true;
    if (node.id && node.id.indexOf("aisaver") === 0) return true;
    for (const sel of SITE.excludeSelectors) {
      try {
        if (node.matches && node.matches(sel)) return true;
      } catch (e) {}
    }
    return false;
  }

  // ---------- AI 消息节点识别 ----------
  // 返回内容节点（markdown 渲染区）数组
  function collectAIContentNodes() {
    const out = [];
    const seen = new Set();

    // 1. 用站点 contentSelectors 直接命中
    for (const sel of SITE.contentSelectors) {
      let nodes = [];
      try { nodes = $$(sel); } catch (e) { continue; }
      for (const n of nodes) {
        if (seen.has(n) || shouldExclude(n)) continue;
        if (looksLikeAssistantContent(n)) {
          seen.add(n);
          out.push(n);
        }
      }
    }
    // 2. 用 messageSelectors 命中消息项，再在其内部找内容
    if (out.length === 0) {
      for (const sel of SITE.messageSelectors) {
        let items = [];
        try { items = $$(sel); } catch (e) { continue; }
        for (const item of items) {
          if (shouldExclude(item)) continue;
          if (!looksLikeAssistantMessage(item)) continue;
          // 在 item 内找最长文本块作为内容节点
          const inner = findLongestTextBlock(item);
          if (inner && !seen.has(inner)) {
            seen.add(inner);
            out.push(inner);
          }
        }
      }
    }
    return out;
  }

  function looksLikeAssistantContent(node) {
    const text = (node.textContent || "").trim();
    if (text.length < 5) return false;
    // 排除输入框
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
    // 启发式：item 内含 markdown 容器且文本较长
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
      if (t.length > bestLen && el.children.length < 50) {
        bestLen = t.length; best = el;
      }
      for (const c of el.children) walk(c);
    };
    walk(root);
    return best;
  }

  // ---------- 快照管理 ----------
  // WeakMap: contentNode -> { text, html, ts }
  const snapshots = new WeakMap();

  function takeSnapshot(node) {
    return {
      text: (node.textContent || "").trim(),
      html: node.innerHTML,
      ts: Date.now()
    };
  }

  const pollSnapshots = debounce(function () {
    const nodes = collectAIContentNodes();
    for (const n of nodes) {
      const prev = snapshots.get(n);
      const cur = takeSnapshot(n);
      // 仅当内容增长或变化时更新（保留"最近确认版本"用于覆盖检测）
      if (!prev || cur.text.length >= prev.text.length || hashStr(cur.text) !== hashStr(prev.text)) {
        snapshots.set(n, cur);
      }
    }
  }, 600);

  // 定时轮询（兜底，确保流式输出期间也有较新快照）
  setInterval(pollSnapshots, 1500);

  // ---------- 记录存储（内存） ----------
  function addRecord(reason, snapshot, extra) {
    if (!snapshot || (!snapshot.text && !snapshot.html)) return false;
    const text = snapshot.text || "";
    if (text.length < 3) return false; // 过滤空/极短
    const id = hashStr(text) + "_" + snapshot.ts;
    // 去重：3 秒内同内容不重复记录
    const now = Date.now();
    if (STORE.records.some(r => r.id === id && now - r.capturedAt < 3000)) return false;
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
    if (STORE.records.length > 500) STORE.records.length = 500; // 上限保护
    onNewRecord(record);
    return true;
  }

  // ---------- 原位恢复 ----------
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

  // ---------- Toast ----------
  function showToast(msg) {
    const old = $(".aisaver-toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.className = "aisaver-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ---------- 悬浮按钮 + 侧边浮层 ----------
  let fab, panelRoot, panelEl, listEl, badgeEl, panelOpen = false;

  function ensureUI() {
    if (fab) return;
    // FAB
    fab = document.createElement("button");
    fab.id = "aisaver-fab";
    fab.title = "AI撤回保存器 - 查看历史";
    fab.innerHTML = "🛡<span class=\"aisaver-fab-badge\" style=\"display:none\">0</span>";
    badgeEl = fab.querySelector(".aisaver-fab-badge");
    fab.addEventListener("click", togglePanel);
    document.body.appendChild(fab);

    // Panel root
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
    const dark = isDarkMode();
    panelEl.classList.toggle("aisaver-dark", dark);
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
    // 绑定事件
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
    return ({
      remove: "节点被删除",
      replace: "内容被覆盖/清空",
      hide: "节点被隐藏",
      regenerate: "重新生成覆盖"
    })[reason] || reason;
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
    try {
      chrome.runtime.sendMessage({ type: "UPDATE_BADGE", count: n });
    } catch (e) {}
  }

  function onNewRecord(record) {
    ensureUI();
    renderList();
    showToast(`捕获到一条撤回消息（${reasonLabel(record.reason)}）`);
  }

  // ---------- 撤回检测核心 ----------
  function handleMutations(mutations) {
    for (const m of mutations) {
      // 1. 节点删除
      if (m.type === "childList" && m.removedNodes && m.removedNodes.length) {
        for (const node of m.removedNodes) {
          if (node.nodeType !== 1 || shouldExclude(node)) continue;
          handleRemovedNode(node, m);
        }
      }
      // 2. 文本变化（覆盖/清空）
      if (m.type === "characterData") {
        const target = m.target && m.target.parentElement;
        if (target && !shouldExclude(target)) {
          handleContentChange(target);
        }
      }
      // 3. 子树 childList 变化（内容被替换）
      if (m.type === "childList" && m.addedNodes && m.addedNodes.length && m.target) {
        if (!shouldExclude(m.target)) handleContentChange(m.target);
      }
      // 4. 属性变化（隐藏）
      if (m.type === "attributes" && m.attributeName) {
        if (m.attributeName === "style" || m.attributeName === "class" || m.attributeName === "hidden" || m.attributeName === "aria-hidden") {
          const el = m.target;
          if (el && el.nodeType === 1 && !shouldExclude(el)) handleHide(el);
        }
      }
    }
  }

  function handleRemovedNode(node, mutation) {
    // 判断被删除的节点是否是 AI 消息内容（或包含 AI 消息内容）
    let contentNodes = [];
    if (isContentLike(node)) contentNodes.push(node);
    else contentNodes = collectAIContentNodesIn(node);

    if (contentNodes.length === 0) return;
    for (const cn of contentNodes) {
      const snap = snapshots.get(cn) || takeSnapshot(cn);
      if (!snap.text || snap.text.length < 3) continue;
      addRecord("remove", snap);
      // 原位恢复：插入到原父节点的原位置
      const parent = mutation.target;
      insertRestoreBlock(parent, mutation.nextSibling, snap, "节点被删除");
    }
  }

  function handleContentChange(target) {
    // target 可能是消息项或内容节点；向上/向下找内容节点
    const contentNodes = isContentLike(target) ? [target] : collectAIContentNodesIn(target);
    for (const cn of contentNodes) {
      const prev = snapshots.get(cn);
      if (!prev) continue;
      const curText = (cn.textContent || "").trim();
      // 覆盖/清空判定：当前很短，之前较长，且长度大幅减少
      if (prev.text.length >= 20 && curText.length < prev.text.length * 0.3) {
        if (addRecord("replace", prev)) {
          // 在该内容节点附近插入恢复块
          insertRestoreBlock(cn.parentElement || cn, cn.nextSibling, prev, "内容被覆盖/清空");
        }
      }
    }
  }

  function handleHide(el) {
    const hidden =
      getComputedStyle(el).display === "none" ||
      getComputedStyle(el).visibility === "hidden" ||
      el.hidden ||
      el.getAttribute("aria-hidden") === "true";
    if (!hidden) return;
    const contentNodes = collectAIContentNodesIn(el);
    for (const cn of contentNodes) {
      const snap = snapshots.get(cn);
      if (!snap || snap.text.length < 3) continue;
      addRecord("hide", snap);
    }
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
    // 若没有命中 contentSelectors，但 root 本身含较长文本，则视作内容
    if (out.length === 0 && root.nodeType === 1 && (root.textContent || "").trim().length > 30 && !shouldExclude(root)) {
      out.push(root);
    }
    return out;
  }

  // ---------- 重新生成按钮监听 ----------
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
  const bindRegenerateDebounced = debounce(bindRegenerateButtons, 800);

  function onRegenerateClick() {
    // 覆盖前保存当前最后一条 AI 消息
    const nodes = collectAIContentNodes();
    if (nodes.length === 0) return;
    const last = nodes[nodes.length - 1];
    const snap = snapshots.get(last) || takeSnapshot(last);
    if (snap.text && snap.text.length > 3) {
      addRecord("regenerate", snap);
    }
  }

  // ---------- 观察器挂载 ----------
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
      handleMutations(muts);
      pollSnapshots();
      bindRegenerateDebounced();
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "aria-hidden"]
    });
  }

  // ---------- 通信 ----------
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "GET_RECORDS") {
        sendResponse({ records: STORE.records, site: SITE.name, url: location.href });
        return;
      }
      if (msg.type === "TOGGLE_PANEL") {
        ensureUI();
        openPanel(msg.open === undefined ? !panelOpen : msg.open);
        sendResponse({ open: panelOpen });
        return;
      }
      if (msg.type === "PING") {
        sendResponse({ ok: true, site: SITE.name, count: STORE.records.length });
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

  // ---------- 初始化 ----------
  function init() {
    ensureUI();
    observeRoot();
    pollSnapshots();
    bindRegenerateButtons();
    updateBadge();
    // SPA 路由切换后重新挂载
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(observeRoot, 600);
      }
    }, 1000);
    // 通知 background 已就绪
    try { chrome.runtime.sendMessage({ type: "CONTENT_READY", site: SITE.name }); } catch (e) {}
    console.log(`[AI撤回保存器] 已在 ${SITE.name} (${location.hostname}) 启动，监听撤回/重新生成/删除的 AI 回复。`);
  }

  // document_idle 后启动
  if (document.readyState === "complete" || document.readyState === "interactive") {
    setTimeout(init, 300);
  } else {
    window.addEventListener("DOMContentLoaded", () => setTimeout(init, 300));
  }
})();
