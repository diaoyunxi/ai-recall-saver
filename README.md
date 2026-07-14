# AI撤回保存器 🛡

> 捕获并保存 AI 网页版被**撤回 / 重新生成 / 删除 / 覆盖**的回复消息——哪怕 AI 撤回了，你也能看到撤回前的完整内容。

支持 **DeepSeek、Kimi、通义千问、豆包、智谱清言、文心一言、腾讯元宝** 等国内主流 AI 网页版，并提供通用兜底方案适配更多站点。

---

## ✨ 功能特性

- **全量监听**：基于 `MutationObserver` 监听节点删除、内容清空/覆盖、节点隐藏、以及「重新生成」按钮触发的覆盖，全方位捕获「撤回」。
- **原位恢复**：在消息被撤回的**原位置**直接插入带「已撤回」标记的恢复块，所见即所得。
- **侧边浮层**：右下角悬浮按钮一键打开历史记录面板，查看所有捕获的撤回消息（含全文、HTML、复制、导出）。
- **纯内存存储**：撤回记录仅保存在当前页面内存中，刷新页面即清空，**保护隐私**，不留痕迹。
- **多站点适配**：内置主流站点选择器配置 + 通用启发式兜底，站点改版也能尽量兜住。
- **角标提示**：扩展图标实时显示当前页面捕获到的撤回数量。
- **自动更新检查**：启动时及每 6 小时检查 GitHub Release，发现新版本桌面通知提醒。
- **误报防护可调**（v1.0.3）：三档灵敏度模式（严格/平衡/激进）+ 调试日志开关。隐藏判定增加延迟确认与可见相似度二次校验，大幅降低折叠展开、切换深浅色主题、虚拟列表滚动、模态框 `aria-hidden` 临时变化等导致的误报；内容覆盖判定阈值与去重窗口全可配置。

---

## 🌐 支持站点

| 站点 | 域名 |
|------|------|
| DeepSeek | chat.deepseek.com |
| Kimi（月之暗面） | kimi.moonshot.cn、kimi.com |
| 通义千问 | tongyi.aliyun.com |
| 豆包 | www.doubao.com |
| 智谱清言 | chatglm.cn、chat.z.ai、chat.zhipuai.cn |
| 文心一言 | yiyan.baidu.com |
| 腾讯元宝 | yuanbao.tencent.com |

> 未在列表中的 AI 站点会自动启用通用兜底方案。

---

## 📦 安装方式

### 方式一：加载已打包的 .crx（推荐）

1. 从 [Releases](https://github.com/diaoyunxi/ai-recall-saver/releases) 下载最新的 `ai-recall-saver-vX.X.X.crx`。
2. 打开 Chrome，地址栏输入 `chrome://extensions/`。
3. 打开右上角「开发者模式」。
4. 将下载的 `.crx` 文件拖入页面，按提示确认安装。

> 注意：由于本扩展未上架 Chrome 应用商店，安装时 Chrome 会提示「非官方扩展」，选择「保留」即可正常使用。

### 方式二：加载未打包扩展（开发者模式）

1. 下载或 `git clone` 本仓库。
2. 打开 `chrome://extensions/`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择本仓库根目录。
4. 访问任一支持的 AI 网页版即可自动生效。

```bash
git clone https://gh.llkk.cc/https://github.com/diaoyunxi/ai-recall-saver.git
```

---

## 🚀 使用方法

1. 安装后，正常使用各 AI 网页版对话。
2. 当 AI 的回复被撤回 / 重新生成 / 删除时：
   - 页面原位置会出现一个**红色虚线框的「⚠ 已撤回」恢复块**，展示撤回前的完整内容。
   - 右下角悬浮按钮的角标数字 +1。
3. 点击右下角悬浮按钮，或点击浏览器工具栏的扩展图标 → 「查看撤回历史」，打开侧边浮层查看所有记录。
4. 在浮层中可：复制文本、查看全文 / HTML、导出全部记录为 JSON、清空记录。

> 💡 撤回记录为**内存存储**，刷新页面后清空。如需长久保存某条内容，请用「导出 JSON」或「复制」。

---

## 🛠 工作原理

1. **站点配置**（`content/sites.js`）：为每个站点提供对话根容器、消息项、消息内容、重新生成按钮等选择器，并提供通用兜底配置。
2. **快照管理**：以 ~600ms 节流轮询所有识别到的 AI 消息内容节点，在 `WeakMap` 中维护「最近一次确认内容快照」——这是捕获覆盖/清空类撤回的关键（`MutationObserver` 不提供旧值）。
3. **撤回判定**（`content/content.js`）：
   - 节点被从 DOM 移除 → **删除型撤回**
   - 文本长度骤减（减少 >70% 且原长 >20）→ **覆盖/清空型撤回**
   - 节点被隐藏（`display:none` / `hidden` / `aria-hidden`）→ **隐藏型撤回**
   - 点击「重新生成」按钮 → 覆盖前保存 → **重新生成型撤回**
4. **原位恢复**：命中后在原父节点原位置插入恢复块。
5. **内存存储**：记录保存在 `window.__AISaver__.records`，刷新即清空。
6. **通信**：content script 与 background service worker 通过消息通信，更新角标与自动更新检查。

---

## 📁 项目结构

```
ai-recall-saver/
├── manifest.json              # MV3 扩展配置
├── background.js              # Service Worker：角标、更新检查、右键菜单
├── content/
│   ├── sites.js               # 各站点 DOM 选择器配置
│   ├── content.js             # 核心：撤回检测、快照、原位恢复、侧边浮层
│   └── content.css            # 恢复块与浮层样式
├── popup/
│   ├── popup.html             # 工具栏弹窗
│   ├── popup.js               # 弹窗逻辑
│   └── popup.css              # 弹窗样式
├── icons/                     # 扩展图标 PNG
├── scripts/
│   ├── gen_icons.py           # 图标生成脚本
│   └── pack_crx.py            # CRX3 打包脚本
└── README.md
```

---

## ⚙️ 打包

本项目提供 `scripts/pack_crx.py` 可一键生成 `.crx3` 文件：

```bash
# 安装依赖
pip install cryptography

# 打包（自动生成私钥或复用已有私钥）
python scripts/pack_crx.py
```

输出文件位于 `dist/ai-recall-saver-v<版本>.crx`。

---

## 📝 版本历史

### v1.0.4（安全加固版）

代码审查安全修复：

- **XSS 防护加固**：`sanitizeHtml` 改用 DOM API（DOMParser）解析替代正则方案，移除 script/iframe/object/embed/svg/link/style/meta/base/form 标签，移除所有 on* 事件属性和 javascript: 协议
- **哈希碰撞修复**：`hashStr` 结合哈希值与文本长度作为键，降低短文本碰撞概率
- **内存泄漏修复**：添加 `beforeunload` 事件清理所有定时器和待确认 Map；路由变化时清理并重建 interval
- **Map 大小限制**：`pendingRemovals`/`pendingHides` 添加 200 条上限检查，超限自动清理最旧条目
- **防御性检查**：`chrome.storage.local.get` 回调添加 `if (!res) return` 防御
- **tabCounts 清理**：安装/更新时清空 tabCounts，防止旧版本遗留的无效 tabId 残留
- **资源访问收窄**：`web_accessible_resources` matches 从 `https://*/*` 收窄为实际支持的站点域名列表
- **DOM 遍历限制**：`findLongestTextBlock` 添加 5000 节点总数限制，防止超大 DOM 树卡顿
- **日志完善**：popup.js 所有 catch 块添加 `console.warn` 输出

### v1.0.3（降低误报率版）

重点修复「内容覆盖误报」与「节点隐藏误报」：

- **三档灵敏度模式**：严格（默认）/ 平衡 / 激进，popup 可切换，实时生效
  - 严格：隐藏延迟 1000ms / 骤减阈值 85% / 相似度 98% / 去重 8s
  - 平衡：隐藏延迟 600ms / 骤减阈值 70% / 相似度 95% / 去重 5s
  - 激进：隐藏延迟 300ms / 骤减阈值 60% / 相似度 90% / 去重 3s
- **隐藏判定重构**：`handleHide` 增加延迟确认 + 恢复可见取消 + 可见相似度二次校验
  - 修复折叠展开、切换深浅色主题、虚拟列表滚动、模态框 `aria-hidden` 临时变化导致的误报
- **内容覆盖判定**：`checkContentRecall` 阈值可配置 + 二次相似度校验，降低 markdown 重渲染误报
- **相似度算法改进**：前缀 + 后缀双校验 + 长度阈值提升 + 最短文本要求
- **站点配置收紧**：
  - 移除智谱清言（chatglm.cn）致命选择器 `[class*='content']`
  - 统一 `excludeSelectors` 基线（输入框/工具栏/模态框/Toast/侧边栏/导航等）
  - 移除危险短词 `ai`/`reply`（子串匹配易误判）
- **调试日志开关**：popup 可开启 `console.debug` 日志，便于排查误报

### v1.0.2

修复 CRX3 打包签名问题。

### v1.0.1

性能重构：流式检测、确认快照、延迟确认删除、mutation 批处理、observer 降级。

### v1.0.0

初版。

---

## ❓ 常见问题

**Q：为什么有些撤回没被捕获？**
A：AI 站点前端会持续改版，选择器可能失效。可尝试刷新页面后重新对话；通用兜底方案会尽量覆盖。欢迎提 issue 反馈具体站点。

**Q：记录会在刷新后保留吗？**
A：不会。本扩展采用纯内存存储以保护隐私，刷新页面即清空。如需保留请用导出功能。

**Q：会泄露我的对话内容吗？**
A：不会。所有数据仅在本地内存中处理，不进行任何网络上传。自动更新检查仅请求 GitHub Release API 获取版本号。

**Q：安装时提示「非官方扩展」怎么办？**
A：因为本扩展未上架 Chrome 商店。选择「保留」即可正常使用，不影响功能。

---

## 📜 许可证

MIT License

---

## 🤝 反馈

如遇问题或适配新站点需求，欢迎提 [Issue](https://github.com/diaoyunxi/ai-recall-saver/issues)。
