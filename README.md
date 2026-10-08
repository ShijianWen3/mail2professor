# mail2professor · agent 式联系导师插件

一个 Chrome/Edge 扩展：在导师主页上点一下，agent 会自己读页面、必要时搜网页、把导师存进导师库、并起草一封你确认后就能发的联系邮件。

版本演进：
- **1.0** 一次性调用：把整页文本塞给模型，让模型返回一段 JSON。
- **2.0** 带工具调用的 agent 循环：模型自己决定读哪个页面、要不要搜索、什么时候入库、什么时候定稿，每一步都显示在侧边栏的 trace 里。
- **2.1** 界面拆成多个页面（主面板极简 + 各功能独立页面）、个人资料扩充到 9 项并自动保存、持久层加写入校验。
- **2.2** 每个厂商的 API Key / BASE URL / 模型分开保存（切厂商互不覆盖）、任务页输入框与推荐提示词完整展示。

## 为什么 agent 循环放在 JS 里（而不是 Python）

这是这个项目最容易被问到的架构问题，结论和理由都记在这里：

- **Chrome MV3 扩展里跑不了 Python。** 没有 Python 运行时；Pyodide（WASM）也走不通——MV3 的 CSP 禁止扩展页面使用 `unsafe-eval` 和远程代码，而 Pyodide 依赖它。所以「用 Python 实现这个插件」在技术上等价于「另外起一个本地 Python 进程，插件退化成它的客户端」。
- **agent 循环本身不是难点，两种语言都是 30 行。** 见 `ReAct.py`（手写）和 `lib/agent.js`（本仓库）：思考 → 调工具 → 观察 → 再思考，逻辑形状完全一样。
- **真正决定语言的是「工具住在哪里」。** 这个 agent 的核心工具全是浏览器独有的能力：读当前标签页、后台开标签页读 JS 渲染的页面（Google Scholar、课题组主页）、跟随链接、复制邮件、`mailto:` 唤起客户端。这些只有扩展能做。放 Python 里反而要给 Python 装浏览器驱动，多一层不确定性。
- **另一个现实约束是分发。** 目标是发给同学用，零安装是它的全部价值；多一个「先装 Python、再开个服务」的步骤，愿意用的人会少一个数量级。

**什么时候该换成 Python**：当它从「一个插件」进化成「你的个人 agent 平台」，需要 arXiv/SMTP 收发信、定时任务、向量记忆、多 agent 协作、Langfuse 观测这些东西的时候。那时候合理的形态是 **Python 当大脑 + 这个扩展当浏览器的手脚**：Python 侧跑 LangGraph（或你 `ReAct_langchain.py` 里的 `create_agent`），扩展通过 WebSocket 暴露 `read_current_page` / `visit_page` 这类底层能力给它调。

代码已经为这条路留好了口子——`runAgent()` 的 `chatFn` 是注入的：

```js
// lib/agent.js
export async function runAgent({ config, tools, messages, onEvent, signal, chatFn = defaultChat })

// 现在：直连厂商 API
// 以后：换成走本地 Python 后端的实现，循环、工具、UI 一行都不用改
const chatFn = async ({ messages, tools, signal }) =>
  (await fetch('http://127.0.0.1:8765/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, tools })
  })).json();
```

## 安装

1. Chrome/Edge 打开 `chrome://extensions/`（Edge 是 `edge://extensions/`）
2. 打开右上角 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本文件夹
4. 点扩展图标打开侧边栏（`background.js` 里设了 `openPanelOnActionClick`）

## 使用

侧边栏是**多页面**结构，主面板只放一个主操作和三个入口：

```
主页  ✉️ 生成联系邮件   ← 主操作
      📚 导师库      已存几位 · 几位待联系
      👤 我的资料    已填 7/9 项 · 还缺：成绩 / 排名
      ⚙️ 模型设置    DeepSeek · deepseek-chat
```

- 点「✉️ 生成联系邮件」进入任务页：任务描述框会按内容自动撑高（默认文案一眼看全），下面是三条推荐任务——标题 + **完整提示词正文**，点一下整段填进输入框，也可以自己改写。点「▶ 开始」后 trace 会实时显示「💭 思考 / 🔧 调用了什么工具 / 观察结果」，可以展开看模型实际读到了什么——这是排查「它为什么这么写」最直接的手段。跑完自动跳到邮件确认页。
- 首次使用（还没填 API Key）会自动进入模型设置页；填好保存后自动回主页。
- **每个厂商的 Key / BASE URL / 模型分开保存**：在 DeepSeek 和 OpenAI 之间来回切不会互相覆盖，各自的设置切回来还在。要换掉某一家的 Key，点模型设置页的「清除本厂商的 Key」即可。
- **所有输入都是自动保存的**，点保存按钮只是额外确认一次，不会出现「填了半天没存上」。

三个预设任务：

| 预设 | agent 会做的事 |
| --- | --- |
| 分析并写邮件 | 读当前页 → 存导师库 → 起草邮件 |
| 深挖研究方向 | 读页面 → 搜近期论文和课题组主页 → 找出可切入的点 → 重写邮件 |
| 整理本页导师 | 在师资列表页上逐位入库（姓名 + 主页链接） |

## 我的资料（写邮件的素材来源）

资料字段定义在 `lib/store.js` 的 `PROFILE_FIELDS` 里，界面表单、完整度统计、喂给模型的画像都由这张表生成——**以后想加字段（比如「意向方向」）只加一行**。

| 字段 | 说明 |
| --- | --- |
| 姓名 / 本科院校 / 专业 | 自我介绍三件套 |
| 成绩 / 排名 | 导师最关心的信息之一，界面会提示补 |
| 竞赛奖项 | 邮件里最有说服力的部分之一 |
| 科研技能 | 编程、工具链、英语等 |
| 科研经历 | 项目、论文、实验室经历 |
| 联系邮箱 / 联系电话 | 会写进邮件落款，方便导师回信 |

主页会显示完整度并列出缺失的核心项（姓名/院校/专业/成绩排名），点提示条直达资料页。

## Agent 的工具集（`lib/tools.js`）

| 工具 | 作用 |
| --- | --- |
| `read_current_page` | 读学生当前浏览的标签页：标题、正文、页面上的邮箱、链接；并判断这是导师页还是师资列表页 |
| `visit_page` | 后台标签页打开任意网址并读取（能处理 JS 渲染的页面，读完自动关掉） |
| `search_web` | 搜索网页（Bing RSS 为主，DuckDuckGo / Bing HTML 兜底，无需额外 key） |
| `save_professor` | 存入导师库（按姓名/邮箱去重合并） |
| `list_professors` | 列出导师库，避免重复劳动、确认谁还没联系 |
| `update_professor_status` | 更新跟进状态或追加备注 |
| `save_email_draft` | 把定稿邮件送进确认面板（收件人 / 主题 / 正文） |
| `open_url` | 在学生浏览器里打开某个页面给他看 |

导师库（主页 → 📚 导师库）按 `new → drafted → contacted → replied → meeting → offer / declined` 跟踪进度，可以导出 JSON。

## 文件结构

```
professor-mail-extension/
├── manifest.json        MV3 配置（host_permissions 用于跨域读取页面）
├── background.js        只做一件事：点图标打开侧边栏
├── content.js           注入页面，结构化提取正文 / 邮箱 / 链接
├── sidepanel.html       界面（主页 + 任务 / 邮件确认 / 导师库 / 资料 / 模型设置 六个页面）
├── sidepanel.js         UI + 编排（页面路由、资料表单、agent trace）
├── lib/
│   ├── providers.js     各家 API → 统一「能调工具的对话」接口（含 Anthropic 协议翻译）
│   ├── agent.js         ReAct 循环 + 系统提示词 + chatFn 注入点
│   ├── tools.js         agent 的工具集
│   └── store.js         持久层：导师库 / 设置 / 资料（含旧版本数据迁移）
├── tests/smoke.test.mjs 单元测试：循环、消息翻译、参数容错、邮箱去混淆、迁移、提示词
└── tools/e2e-verify.mjs 端到端自检：真 Chrome 加载扩展，走真实 UI 跑完整任务
```

## 持久层设计（踩过的坑都在这）

存在 `chrome.storage.local`，结构是**三个大对象**而不是一堆扁平 key：

```
llm:        { provider, maxSteps, perProvider: { 厂商: { apiKey, baseUrl, model } } }
profile:    { name, school, major, gpaRank, awards, skills, research, email, phone }
lang / professors / notes
```

- **为什么用大对象**：扁平 key 需要维护一份 key 列表，新增字段时漏加一个就变成「输入了但存不上」。现在读用 `get(null)` 全量读、写整对象覆盖，加字段只改 `PROFILE_FIELDS`。
- **为什么按厂商存**：`llm.perProvider[厂商]` 一家一套 key / base URL / 模型。只存一份 key 的话，切到另一家再存一次就把上一家冲掉了；自定义的 BASE URL（比如「OpenAI 兼容」里填的本地或代理地址）同理。
- **写入后读回校验**：`writeVerified()` 写完立刻读回比对，失败就把错误抛给界面显示，不再出现「明明没存上却显示 ✓ 已保存」。比对用的是顺序无关的 `stableStringify()`——因为 `chrome.storage` 读回时会把对象 key 按字母序重排，裸 `JSON.stringify` 比对会天天误报保存失败（这个坑真踩过）。
- **旧数据迁移**：`migrate()` 兼容 1.0/2.0 的扁平字段（`apiKey` / `modelProvider` / `myName` / `myBackground`…）和 2.1 的单套 key，统一收敛到 `perProvider`。旧 key 故意不删以免误删数据，但只有在新结构不存在时才采纳它们，否则旧值会在每次启动时覆盖新值。迁移逻辑是纯函数，有单测。

## 开发自检

```bash
# 单元测试（32 项）
node --test tests/smoke.test.mjs

# 端到端（44 项）：起本地 mock 模型和假导师主页，用真 Chrome 加载扩展跑完一次任务
node tools/e2e-verify.mjs
```

端到端脚本不碰任何外部 API，也不要你的 key：它自己起一个假的 OpenAI 兼容服务，按脚本返回「先读页面 → 入库 → 写草稿 → 收尾」，并且**走真实 UI 路径**（点模型商、填 key、点保存、填资料、点开始），断言这些：

- 首次进入自动路由到模型设置页，配置完自动回主页
- API Key 与个人资料真的落进 storage（含自动保存），且重开侧边栏后只剩主页可见、内容逐项恢复（这是两个曾经的真实 bug 的回归测试）
- 切厂商时 Key 框不显示别家的 key、切回来 key 与自定义 BASE URL 都还在、两家 key 同时存在于 storage
- 任务输入框能完整显示默认文案（不出现滚动条），三条推荐任务完整展示未被截断
- 任何时刻只允许一个页面可见（防止「设置块一直挂着」那类问题复发）
- 学生资料（竞赛、技能、排名）确实进入了系统提示词
- 页面上 `zhangwei (at) cs (dot) example (dot) edu` 被还原成 `zhangwei@cs.example.edu` 再传给模型
- trace 覆盖「读页面 → 入库 → 写草稿」，导师入库后状态推进到 `drafted`

跑完会把各页面截图写到 `tools/last-run-*.png`。

> 注：Chrome 137+ 已禁用 `--load-extension`（防侧载），所以脚本改走 CDP 的 `Extensions.loadUnpacked` 来加载未打包扩展。

## 已知限制

- **PDF 主页读不了**：Chrome 的 PDF 阅读器里注入不了 content script，工具会明确回报「这是 PDF」，由 agent 提醒你手动处理。
- **需要登录的页面读不到内容**：`fetch`/后台标签页拿到的是未登录视图，这是浏览器的边界，不是 bug。
- **搜索依赖公开入口**：Bing RSS / DuckDuckGo 的 HTML 端点哪天改结构就会失效，脚本里有多级兜底，真挂了加一个 Tavily/Serper 的 key 即可（`search_web` 是唯一需要改的地方）。
- **API Key 存在 `chrome.storage.local`**，只在本机；页面内容会发给你选择的模型厂商。
- **侧边栏关掉会中断运行中的任务**：agent 循环跑在侧边栏页面里，关掉面板等于关掉进程。要长时间无人值守的任务（批量几十位导师），就该上前面说的 Python 后端形态了。
