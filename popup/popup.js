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

  loadRecords();
});
