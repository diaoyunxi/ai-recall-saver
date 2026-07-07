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
(function (global) {
  "use strict";

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

  global.AISaverSites = { SITES, FALLBACK, EXCLUDE_BASELINE, getSiteConfig };
})(window);
