/**
 * AI撤回保存器 - 弹窗逻辑
 *
 * 职责：
 *  1. 展示当前页面 content script 状态（站点名、记录数、监听状态）。
 *  2. 灵敏度模式切换与调试日志开关（写入 chrome.storage，content.js 实时监听）。
 *  3. 更新检查信息展示。
 *  4. 按钮事件：查看历史、刷新、清空、导出。
 */
document.addEventListener("DOMContentLoaded", async () => {
  const versionEl = document.getElementById("version");
  const siteNameEl = document.getElementById("siteName");
  const countEl = document.getElementById("count");
  const monitorEl = document.getElementById("monitor");
  const updateEl = document.getElementById("update");
  const newVerEl = document.getElementById("newVer");
  const updateLink = document.getElementById("updateLink");
  const aboutLink = document.getElementById("about");

  const MANIFEST = chrome.runtime.getManifest();
  versionEl.textContent = "v" + MANIFEST.version;

  /**
   * 获取当前活动标签页
   * @returns {Promise<chrome.tabs.Tab|null>}
   */
  async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0] || null;
  }

  /**
   * 获取活动 tab 的 content script 数据并更新 UI
   */
  async function loadRecords() {
    const tab = await getActiveTab();
    if (!tab) {
      siteNameEl.textContent = "未检测到页面";
      monitorEl.textContent = "未运行";
      monitorEl.className = "value";
      return;
    }
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: "GET_RECORDS" });
      siteNameEl.textContent = resp.site || location.hostname;
      const count = (resp.records && resp.records.length) || 0;
      countEl.textContent = count;
      monitorEl.textContent = "运行中";
      monitorEl.className = "value ok";
    } catch (e) {
      // content script 未注入（非支持站点或页面未就绪）
      siteNameEl.textContent = "当前页面不受支持";
      monitorEl.textContent = "未运行";
      monitorEl.className = "value";
      countEl.textContent = "0";
    }
  }

  // 按钮事件
  document.getElementById("btnPanel").addEventListener("click", async () => {
    try {
      const tab = await getActiveTab();
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL", open: true });
        window.close();
      }
    } catch (e) {
      // 预期内错误（content script 未注入），静默处理
    }
  });

  document.getElementById("btnRefresh").addEventListener("click", loadRecords);

  document.getElementById("btnClear").addEventListener("click", async () => {
    if (!confirm("确定清空当前页面的所有撤回记录？")) return;
    try {
      const tab = await getActiveTab();
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, { type: "CLEAR_RECORDS" });
        loadRecords();
      }
    } catch (e) {
      // content script 未注入，静默处理
    }
  });

  document.getElementById("btnExport").addEventListener("click", async () => {
    try {
      const tab = await getActiveTab();
      if (tab) await chrome.tabs.sendMessage(tab.id, { type: "EXPORT_RECORDS" });
    } catch (e) {
      // 预期内错误（content script 未注入），静默处理
    }
  });

  // 更新检查展示
  try {
    const res = await chrome.storage.local.get("updateInfo");
    const info = res.updateInfo;
    if (info && info.hasUpdate) {
      updateEl.style.display = "";
      newVerEl.textContent = info.latest;
      updateLink.href = info.url || info.downloadUrl || "";
    }
  } catch (e) {
    // 存储读取失败，静默忽略
  }

  aboutLink.href = "https://github.com/diaoyunxi/ai-recall-saver";

  // v1.0.3：灵敏度模式切换与调试日志开关
  const sensSeg = document.getElementById("sensitivitySeg");
  const sensTip = document.getElementById("sensTip");
  const debugToggle = document.getElementById("debugToggle");
  const SENS_TIPS = {
    strict: "严格：宁可漏判，阈值高、延迟长、二次校验严格",
    balanced: "平衡：折中，接近 v1.0.2 行为",
    aggressive: "激进：宁可误报，阈值低、延迟短"
  };

  /**
   * 应用灵敏度模式到 UI
   * @param {string} sens - 灵敏度模式名（strict/balanced/aggressive）
   */
  function applySensitivity(sens) {
    sensSeg.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-sens") === sens);
    });
    sensTip.textContent = SENS_TIPS[sens] || SENS_TIPS.strict;
  }

  // 读取已保存配置（默认 strict）
  try {
    const res = await chrome.storage.local.get(["sensitivity", "debugMode"]);
    applySensitivity(res.sensitivity || "strict");
    debugToggle.checked = !!res.debugMode;
  } catch (e) {
    // 存储读取失败，使用默认值
    applySensitivity("strict");
  }

  // 点击切换灵敏度模式（写入 chrome.storage，content.js 通过 onChanged 监听实时生效）
  sensSeg.addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    const sens = btn.getAttribute("data-sens");
    chrome.storage.local.set({ sensitivity: sens });
    applySensitivity(sens);
  });

  // 切换调试日志开关
  debugToggle.addEventListener("change", () => {
    chrome.storage.local.set({ debugMode: debugToggle.checked });
  });

  loadRecords();
});
