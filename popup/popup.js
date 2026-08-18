/**
 * AI撤回保存器 - 弹窗逻辑
 */
document.addEventListener("DOMContentLoaded", () => {
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

  // 获取活动 tab 的 content script 数据
  function loadRecords() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) {
        siteNameEl.textContent = "未检测到页面";
        monitorEl.textContent = "未运行";
        monitorEl.className = "value";
        return;
      }
      const tabId = tabs[0].id;
      chrome.tabs.sendMessage(tabId, { type: "GET_RECORDS" }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          // content script 未注入（非支持站点或页面未就绪）
          siteNameEl.textContent = "当前页面不受支持";
          monitorEl.textContent = "未运行";
          monitorEl.className = "value";
          countEl.textContent = "0";
          return;
        }
        siteNameEl.textContent = resp.site || location.hostname;
        const count = (resp.records && resp.records.length) || 0;
        countEl.textContent = count;
        monitorEl.textContent = "运行中";
        monitorEl.className = "value ok";
      });
    });
  }

  // 按钮事件
  document.getElementById("btnPanel").addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "TOGGLE_PANEL", open: true }).then(() => window.close()).catch(() => {});
    });
  });

  document.getElementById("btnRefresh").addEventListener("click", loadRecords);

  document.getElementById("btnClear").addEventListener("click", () => {
    if (!confirm("确定清空当前页面的所有撤回记录？")) return;
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "CLEAR_RECORDS" }, () => loadRecords());
    });
  });

  document.getElementById("btnExport").addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: "EXPORT_RECORDS" });
    });
  });

  // 更新检查展示
  chrome.storage.local.get("updateInfo", (res) => {
    const info = res.updateInfo;
    if (info && info.hasUpdate) {
      updateEl.style.display = "";
      newVerEl.textContent = info.latest;
      updateLink.href = info.url || info.downloadUrl || "";
    }
  });

  aboutLink.href = `https://github.com/diaoyunxi/ai-recall-saver`;

  // v1.0.3：灵敏度模式切换与调试日志开关
  const sensSeg = document.getElementById("sensitivitySeg");
  const sensTip = document.getElementById("sensTip");
  const debugToggle = document.getElementById("debugToggle");
  const SENS_TIPS = {
    strict: "严格：宁可漏判，阈值高、延迟长、二次校验严格",
    balanced: "平衡：折中，接近 v1.0.2 行为",
    aggressive: "激进：宁可误报，阈值低、延迟短"
  };
  function applySensitivity(sens) {
    sensSeg.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-sens") === sens);
    });
    sensTip.textContent = SENS_TIPS[sens] || SENS_TIPS.strict;
  }
  // 读取已保存配置（默认 strict）
  chrome.storage.local.get(["sensitivity", "debugMode"], (res) => {
    const sens = res.sensitivity || "strict";
    applySensitivity(sens);
    debugToggle.checked = !!res.debugMode;
  });
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
