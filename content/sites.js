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
      assistantHints: ["assistant", "ai", "bot"],
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
      assistantHints: ["assistant", "ai", "bot"],
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
        "[class*='markdown']",
        "[class*='content']"
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
    assistantHints: ["assistant", "bot", "ai", "reply"],
    regenerateSelectors: [
      "[class*='regenerate']",
      "button[aria-label*='重新生成']",
      "button[aria-label*='Regenerate']",
      "button[title*='重新']"
    ],
    excludeSelectors: ["textarea", "input", "[contenteditable]", "pre code"]
  };

  /**
   * 根据当前 hostname 获取站点配置
   * @param {string} hostname
   * @returns {object} 合并了 fallback 的站点配置
   */
  function getSiteConfig(hostname) {
    const exact = SITES[hostname];
    if (!exact) {
      // 未知站点：使用通用兜底配置
      return Object.assign({ key: "fallback", hostname }, FALLBACK);
    }
    // 已知站点：仅使用该站点的精确配置，不再合并 FALLBACK 的宽泛选择器。
    // 旧逻辑会把 FALLBACK 的 [class*='message'] / [class*='content-text'] 等
    // 兜底选择器并入已知站点，导致侧边栏、欢迎语、设置面板等非对话元素被误识别为 AI 回复。
    return Object.assign({ key: hostname, hostname }, exact);
  }

  global.AISaverSites = { SITES, FALLBACK, getSiteConfig };
})(window);
