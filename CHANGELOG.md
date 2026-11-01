# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.5] - 2026-10-12

### Added
- 书签版诊断增强：诊断 Toast 延迟初始化确保 DOM 就绪
- DeepSeek SSE 监听：从 completion 请求响应中直接提取 AI 回复
- 悬浮按钮/侧边面板 UI
- 导出 JSON 功能
- 诊断日志（debugMode 开启后）

### Fixed
- 降低误报率：修复"内容覆盖误报"与"节点隐藏误报"

## [1.0.4] - 2026-09-30

### Added
- Support for additional AI platforms
- Improved snapshot capture reliability

### Fixed
- XSS vulnerability in HTML snapshot rendering
- Memory leak in long-running sessions
