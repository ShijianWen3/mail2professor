# 保研邮件助手 · 浏览器插件

一个帮助你在保研联系导师时自动分析主页、生成个性化邮件的 Chrome/Edge 插件。

## 功能

- 📄 自动读取当前页面文本，提取导师姓名、邮箱、研究方向
- 🤖 调用 Claude AI 生成量身定制的联系邮件
- 📨 一键触发 `mailto:` 打开本地邮件客户端（Outlook/Mail/Thunderbird 均支持）
- 💾 保存你的个人信息（姓名、院校、背景），下次无需重填

## 安装方法

### Chrome / Edge

1. 打开扩展管理页面：
   - Chrome：地址栏输入 `chrome://extensions/`
   - Edge：地址栏输入 `edge://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择本文件夹（`professor-mail-extension`）

## 使用步骤

1. 打开目标导师的个人主页
2. 点击浏览器右上角的插件图标
3. 首次使用：输入你的 Anthropic API Key（可在 https://console.anthropic.com 免费获取）
4. 填写你的姓名、院校、背景简介（只需填一次）
5. 点击「分析当前页面并生成邮件」
6. 稍等几秒，AI 会提取导师信息并生成邮件草稿
7. 确认/修改邮件内容后，点击「打开邮件客户端」即可发送

## 注意事项

- API Key 仅存储在本地浏览器（`chrome.storage.local`），不会上传任何服务器
- 页面内容通过 Anthropic API 发送用于分析，请勿在敏感网络环境下使用
- 如页面无法被读取（如 PDF 简历），可手动复制内容告知导师

## 文件结构

```
professor-mail-extension/
├── manifest.json    # 插件配置
├── popup.html       # 弹窗界面
├── popup.js         # 主逻辑
├── content.js       # 页面内容提取（备用）
├── icons/           # 图标
└── README.md
```
