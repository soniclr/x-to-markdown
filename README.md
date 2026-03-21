# X to Markdown

一个 Chrome 扩展，可以将 X (Twitter) 上的帖子一键保存为 Markdown 文件到本地文件夹。

配合 Obsidian 使用时，只需选择 vault 内的文件夹，保存的文件会自动出现在 Obsidian 中。

## 功能

- 每条推文下方显示保存按钮，点击即可保存
- 右侧悬浮按钮，保存当前可见区域的推文
- 悬浮按钮可拖动，位置自动记忆
- 生成完整的 Markdown 文件，包含 YAML frontmatter
- 支持保存推文正文、互动数据、媒体链接、引用推文
- 可在插件设置中自定义 Markdown 内容选项
- 首次保存时选择文件夹，之后自动保存到同一位置

## 安装

### 从源码安装（开发者模式）

1. 下载本项目

   ```bash
   git clone https://github.com/soniclr/x-to-markdown.git
   ```

2. 打开 Chrome，进入扩展管理页面

   在地址栏输入 `chrome://extensions/` 并回车

3. 开启右上角的 **开发者模式**

4. 点击 **加载已解压的扩展程序**

5. 选择项目中的 `src` 文件夹

6. 完成安装，在 X (Twitter) 页面即可使用

## 使用方法

1. 打开 [x.com](https://x.com) 或 [twitter.com](https://twitter.com)
2. 在任意推文下方的操作栏，点击保存图标（💾）
3. 首次使用会弹出文件夹选择器，选择你想保存的文件夹
4. 之后每次点击保存会自动写入到该文件夹
5. 如需更换文件夹，点击扩展图标，在弹窗中点击「更换」

### 配合 Obsidian

选择文件夹时，直接选择 Obsidian vault 中的任意文件夹即可。保存的 Markdown 文件会自动出现在 Obsidian 中。

## Markdown 输出示例

```markdown
---
tags: []
url: https://x.com/user/status/123456
author: "用户名 (@handle)"
published: 2025-01-01
source: X (Twitter)
saved_at: 2025-01-01
---

# 推文内容标题

> [!info] Post Info
> **Author**: 用户名 (@handle)
> **Link**: https://x.com/user/status/123456
> **Published**: 2025/01/01 12:00
> **Metrics**: Likes: 42 | Reposts: 10 | Views: 1.2K

## Content

推文正文内容...

## Media

![image](https://pbs.twimg.com/media/xxx.jpg)
```

## 设置选项

点击扩展图标可配置：

- **包含 YAML frontmatter** — 在文件头部生成元数据
- **包含互动数据** — 保存点赞、转发、浏览量等
- **包含媒体链接** — 保存图片和视频链接

## 技术实现

- Chrome Extension Manifest V3
- File System Access API（本地文件写入）
- IndexedDB（持久化文件夹权限）
- 纯 JavaScript，无依赖

## 许可证

MIT
