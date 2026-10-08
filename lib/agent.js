// lib/agent.js
// ReAct 循环本体：思考 → 调工具 → 观察 → 再思考 …… → 收尾。
// 和 ReAct.py 手写版是同一个循环，只是换成 JS + 事件回调（UI 要实时显示每一步）。
//
// 关键点：chat 函数是注入进来的（默认 providers.chat）。
// 想换成 Python 后端（FastAPI + LangGraph），只需要传一个走 WebSocket 的 chat 实现，
// 循环、工具、UI 全都不用改。

import { chat as defaultChat, presetOf } from './providers.js';

export const DEFAULT_MAX_STEPS = 12;

const STATUS_HINT = {
  new: '待联系', drafted: '已起草', contacted: '已联系', replied: '已回复',
  meeting: '已约聊', offer: '有offer', declined: '已婉拒', archived: '归档'
};

export function buildSystemPrompt({ lang, student = {}, storeBrief = '', pageContext = '' }) {
  const isZh = lang !== 'en';

  const persona = isZh
    ? `你是 mail2professor，一个帮中国学生联系导师（保研 / 申博 / 暑研 / 套磁）的浏览器 Agent。
你可以调用工具去读页面、搜网页、查导师库、存草稿。工作方式是：先拿到事实，再动手，最后收尾。`
    : `You are mail2professor, a browser agent that helps Chinese students reach out to professors.
You call tools to read pages, search the web, keep a professor CRM, and save email drafts.`;

  const rules = isZh
    ? `铁律（违反会让真实教授收到错误邮件）：
1. 导师的姓名、邮箱、研究方向、论文，只能来自工具返回的真实内容。页面上没有就写"未找到"，或用 visit_page / search_web 去找，绝不编造。
2. 邮箱优先用页面上明确写出的地址；"name (at) xxx (dot) edu" 这类混淆要还原成正常邮箱。拿不到就留空，并在总结里提醒学生手动填。
3. 写邮件前，先用 save_professor 把这位导师存进导师库（同名会合并）。
4. 邮件必须通过 save_email_draft 提交（学生在面板里确认后自己发送）。不要只在正文里贴一段邮件却不调用工具。
5. 邮件要具体到他的研究：引用你实际读到的方向、课程、论文或实验室名，别写"我对您的研究很感兴趣"这种空话。
6. 页面上看到多位数师时（如师资列表页），逐位 save_professor，不要只处理第一个。
7. 每轮可以并行发起多个互不依赖的工具调用（例如同时读多个链接）。
8. 收尾时用 3 句以内总结：查到了什么、邮件切入点是什么、还缺什么。`
    : `Hard rules:
1. Names, emails, research areas and papers must come from tool output. Never invent them.
2. Prefer emails written explicitly on the page; de-obfuscate "name (at) x (dot) edu". If unknown, leave empty and say so.
3. Call save_professor before drafting the email.
4. Submit the email through save_email_draft (the student reviews and sends it).
5. Be specific to the professor's actual research; no generic flattery.
6. If the page lists many professors, save each one.
7. Batch independent tool calls in the same turn.
8. Finish with a summary under 3 sentences.`;

  const writing = isZh
    ? `邮件写法：简体中文，200-350 字。结构：一句自我介绍（姓名/学校/专业/GPA）→ 两三句说明你为什么对他的具体方向感兴趣（引用读到的内容）→ 你能带来什么（项目/技能）→ 礼貌收尾并留下联系方式。`
    : `Email style: English, 200-350 words. Self-intro → why this professor's specific work → what you bring → polite close with contact info.`;

  const profile = isZh
    ? `学生画像：
- 姓名：${student.name || '（未填写）'}
- 本科院校：${student.school || '（未填写）'}
- 背景：${student.background || '（未填写）'}`
    : `Student profile:
- Name: ${student.name || '(not set)'}
- School: ${student.school || '(not set)'}
- Background: ${student.background || '(not set)'}`;

  return [
    persona,
    rules,
    writing,
    profile,
    isZh ? `导师库现状：\n${storeBrief}` : `Professor CRM:\n${storeBrief}`,
    pageContext
  ].filter(Boolean).join('\n\n');
}

// 把一条工具结果压成模型看得懂的短文本，超长就截断并明确告知（避免模型以为读全了）
export function packToolResult(value, maxChars = 6000) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value, null, 1);
    } catch {
      text = String(value);
    }
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[已截断，原始长度 ${text.length} 字符]`;
}

/**
 * 跑一轮 agent。
 * @param {object}   opts
 * @param {object}   opts.config     resolveConfig() 的结果
 * @param {Array}    opts.tools      createTools() 的结果
 * @param {Array}    opts.messages   初始消息（含 system）
 * @param {number}   opts.maxSteps
 * @param {function} opts.onEvent    事件回调
 * @param {AbortSignal} opts.signal
 * @param {function} opts.chatFn     可注入的模型调用（换 Python 后端的接口点）
 * @returns {Promise<{content:string, steps:number, stopped:boolean}>}
 */
export async function runAgent({
  config,
  tools,
  messages,
  maxSteps = DEFAULT_MAX_STEPS,
  onEvent = () => {},
  signal,
  chatFn = defaultChat
}) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const toolSchemas = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }));

  const history = [...messages];
  let steps = 0;   // 已真正执行的轮数（用 i 循环、单独记录，避免 for 的 ++ 让返回值多算一轮）
  let stopped = false;
  let finalText = '';

  for (let i = 1; i <= maxSteps; i++) {
    steps = i;
    if (signal?.aborted) { stopped = true; break; }

    onEvent({ type: 'thinking', step: steps });

    let reply;
    try {
      reply = await chatFn({
        config,
        messages: history,
        tools: toolSchemas,
        signal
      });
    } catch (e) {
      if (e.name === 'AbortError' || signal?.aborted) { stopped = true; break; }
      onEvent({ type: 'error', message: e.message });
      throw e;
    }

    // 情况 A：模型不再调工具 → 拿到最终回答，循环结束
    if (!reply.toolCalls?.length) {
      finalText = reply.content || '';
      history.push({ role: 'assistant', content: finalText });
      onEvent({ type: 'final', content: finalText, step: steps });
      break;
    }

    // 情况 B：模型决定调工具（Act）
    if (reply.content) onEvent({ type: 'thought', content: reply.content, step: steps });

    history.push({
      role: 'assistant',
      content: reply.content || '',
      toolCalls: reply.toolCalls
    });

    for (const call of reply.toolCalls) {
      if (signal?.aborted) { stopped = true; break; }

      // 同一个 assistant 轮次里的多个工具调用串行执行：顺序可预期，trace 好读
      onEvent({ type: 'tool_start', name: call.name, args: call.args, id: call.id, step: steps });

      let result;
      try {
        const tool = toolMap.get(call.name);
        if (!tool) throw new Error(`没有名为 ${call.name} 的工具，可用工具：${[...toolMap.keys()].join(', ')}`);
        result = await tool.run(call.args || {});
      } catch (e) {
        // 报错也回填给模型，让它自己换策略 —— 这是 agent 能自愈的关键
        result = { error: `工具执行失败: ${e.message}` };
      }

      const packed = packToolResult(result);
      onEvent({ type: 'tool_end', name: call.name, id: call.id, result: packed, step: steps });
      history.push({ role: 'tool', toolCallId: call.id, name: call.name, content: packed });
    }

    if (stopped) break;
    if (steps === maxSteps) onEvent({ type: 'limit', message: '达到最大步数，已停止' });
  }

  return { content: finalText, steps, stopped, messages: history };
}

export function describeStatus(status) {
  return STATUS_HINT[status] || status;
}

export function describeProvider(config) {
  return `${presetOf(config.provider).label} · ${config.model}`;
}
