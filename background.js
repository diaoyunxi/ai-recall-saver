/**
 * AI撤回保存器 - 后台 Service Worker
 *
 * 职责：
 *  1. 维护扩展图标角标（撤回计数）。
 *  2. 启动时检查 GitHub Release 最新版本，发现新版本则桌面通知 + 写入存储供 popup 展示。
 *  3. 右键菜单：一键打开/关闭侧边浮层。
 *  4. 消息中转：popup <-> content script。
 *
 * 注意：MV3 Service Worker 会被挂起，定时任务使用 chrome.alarms。
 */
const GITHUB_OWNER = "diaoyunxi";
const REPO_NAME = "ai-recall-saver";
const RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${REPO_NAME}/releases/latest`;
const MANIFEST = chrome.runtime.getManifest();
const CURRENT_VERSION = MANIFEST.version;

// ---------- 角标 ----------
function setBadge(count) {
  const text = count > 0 ? (count > 99 ? "99+" : String(count)) : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#e85d5d" });
  chrome.action.setTitle({
    title: count > 0
      ? `AI撤回保存器 - 已捕获 ${count} 条撤回`
      : "AI撤回保存器 - 点击查看撤回历史"
  });
}

// 存储各 tab 的撤回计数
const tabCounts = {};

// ---------- 自动更新检查 ----------
function compareVersion(a, b) {
  // 返回 1 表示 a>b，-1 表示 a<b，0 相等
  const pa = String(a).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function checkUpdate() {
  try {
    const res = await fetch(RELEASE_API, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    const latestTag = data.tag_name || "";
    if (!latestTag) return;
    if (compareVersion(latestTag, CURRENT_VERSION) > 0) {
      // 有新版本
      const info = {
        hasUpdate: true,
        latest: latestTag,
        current: CURRENT_VERSION,
        url: data.html_url,
        downloadUrl: (data.assets && data.assets[0] && data.assets[0].browser_download_url) || data.html_url,
        notes: data.body || "",
        checkedAt: Date.now()
      };
      await chrome.storage.local.set({ updateInfo: info });
      // 桌面通知
      chrome.notifications.create("aisaver-update", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "AI撤回保存器 发现新版本",
        message: `新版本 ${latestTag} 已发布（当前 v${CURRENT_VERSION}），点击前往更新。`,
        priority: 2,
        isClickable: true
      });
      chrome.notifications.onClicked.addListener(function notifyClick(id) {
        if (id === "aisaver-update") {
          chrome.tabs.create({ url: info.url });
          chrome.notifications.clear(id);
          chrome.notifications.onClicked.removeListener(notifyClick);
        }
      });
    } else {
      await chrome.storage.local.set({ updateInfo: { hasUpdate: false, current: CURRENT_VERSION, latest: latestTag, checkedAt: Date.now() } });
    }
  } catch (e) {
    // 网络错误静默
  }
}

// ---------- 消息中转 ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  switch (msg.type) {
    case "CONTENT_READY":
      if (sender.tab && sender.tab.id != null) {
        setBadge(tabCounts[sender.tab.id] || 0);
      }
      break;
    case "UPDATE_BADGE": {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) tabCounts[tabId] = msg.count || 0;
      // 仅更新当前活动 tab 的角标
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].id === tabId) setBadge(msg.count || 0);
      });
      break;
    }
    case "CHECK_UPDATE":
      checkUpdate().then(() => sendResponse({ ok: true }));
      return true; // 异步响应
    default:
      break;
  }
});

// ---------- 右键菜单 ----------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "aisaver-toggle-panel",
    title: "AI撤回保存器：打开/关闭历史浮层",
    contexts: ["all"]
  });
  setBadge(0);
  // 创建定时闹钟：每 6 小时检查一次更新
  chrome.alarms.create("aisaver-update-check", { periodInMinutes: 360 });
  // 安装/更新后立即检查一次
  checkUpdate();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "aisaver-update-check") checkUpdate();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "aisaver-toggle-panel" && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_PANEL" }).catch(() => {});
  }
});

// 切换标签页时更新角标
chrome.tabs.onActivated.addListener((activeInfo) => {
  setBadge(tabCounts[activeInfo.tabId] || 0);
});

// 浏览器启动时检查更新
chrome.runtime.onStartup.addListener(() => {
  checkUpdate();
});
