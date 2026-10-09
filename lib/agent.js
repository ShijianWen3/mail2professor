// lib/agent.js
// ReAct 循环本体：思考 → 调工具 → 观察 → 再思考 …… → 收尾。
// 和 ReAct.py 手写版是同一个循环，只是换成 JS + 事件回调（UI 要实时显示每一步）。
//
// 关键点：chat 函数是注入进来的（默认 providers.chat）。
// 想换成 Python 后端（FastAPI + LangGraph），只需要传一个走 WebSocket 的 chat 实现，
// 循环、工具、UI 全都不用改。

import { chat as defaultChat, presetOf } from './providers.js';
import { PROFILE_FIELDS, profileCompleteness, DEFAULT_MAX_STEPS } from './store.js';

export { DEFAULT_MAX_STEPS };

const STATUS_HINT = {
  new: '待联系', drafted: '已起草', contacted: '已联系', replied: '已回复',
  meeting: '已约聊', offer: '有offer', declined: '已婉拒', archived: '归档'
};

// 把学生资料整理成提示词里的一段。只给填过的字段，缺什么也明说，
// 免得模型自己脑补学生的成绩或奖项。
export function profileBlock(profile = {}, isZh = true) {
  const lines = [];
  for (const field of PROFILE_FIELDS) {
    const value = String(profile[field.key] || '').trim();
    if (!value) continue;
    lines.push(`- ${field.label[isZh ? 'zh' : 'en']}：${value}`);
  }
  const { missing } = profileCompleteness(profile);
  const missingLabels = missing
    .map((key) => PROFILE_FIELDS.find((f) => f.key === key)?.label[isZh ? 'zh' : 'en'])
    .filter(Boolean);

  if (!lines.length) {
    return isZh ? '学生画像：（学生还没填任何资料，写邮件时不要编造成绩、奖项或经历）' : 'Student profile: (empty — do not invent credentials)';
  }
  const tail = missingLabels.length
    ? isZh
      ? `（学生没填：${missingLabels.join('、')}——需要时不要替他编，可在总结里提醒他补）`
      : `(Not provided: ${missingLabels.join(', ')} — never invent these)`
    : '';
  return `${isZh ? '学生画像' : 'Student profile'}：\n${lines.join('\n')}\n${tail}`.trim();
}

export function buildSystemPrompt({ lang, profile = {}, storeBrief = '', pageContext = '' }) {
  const isZh = lang !== 'en';

  const persona = isZh
    ? `你是 mail2professor，一个帮中国学生联系导师（保研 / 申博 / 暑研 / 套磁）的浏览器 Agent。
你可以调用工具去读页面、搜网页、查导师库、存草稿。工作方式是：先拿到事实，再动手，最后收尾。`
    : `You are mail2professor, a browser agent that helps Chinese students reach out to professors.
You call tools to read pages, search the web, keep a professor CRM, and save email drafts.`;

  const rules = isZh
    ? `铁律（违反会让真实教授收到错误邮件）：
1. 导师的姓名、邮箱、研究方向、论文，只能来自工具返回的真实内容；学生自己的成绩、奖项、经历，只能用"学生画像"里给的内容。两边都没有的就不要写，绝不编造。
2. 邮箱优先用页面上明确写出的地址；"name (at) xxx (dot) edu" 这类混淆要还原成正常邮箱。拿不到就留空，并在总结里提醒学生手动填。
3. 写邮件前，先用 save_professor 把这位导师存进导师库（同名会合并）。
4. 邮件必须通过 save_email_draft 提交（学生在面板里确认后自己发送）。不要只在正文里贴一段邮件却不调用工具。
5. 邮件要具体到他的研究：引用你实际读到的方向、课程、论文或实验室名，别写"我对您的研究很感兴趣"这种空话。
6. 学生画像里的竞赛奖项、科研技能、科研经历是这封邮件最有说服力的部分：挑 2-3 条与导师方向最相关的写进去，不要整段罗列。
7. 页面上看到多位数师时（如师资列表页），逐位 save_professor，不要只处理第一个。
8. 每轮可以并行发起多个互不依赖的工具调用（例如同时读多个链接）。
9. 收尾时用 3 句以内总结：查到了什么、邮件切入点是什么、还缺什么。`
    : `Hard rules:
1. Names, emails, research areas and papers must come from tool output; the student's credentials must come only from the "Student profile" block. Never invent either.
2. Prefer emails written explicitly on the page; de-obfuscate "name (at) x (dot) edu". If unknown, leave empty and say so.
3. Call save_professor before drafting the email.
4. Submit the email through save_email_draft (the student reviews and sends it).
5. Be specific to the professor's actual research; no generic flattery.
6. Pick the 2-3 most relevant items from the student's awards/skills/research — do not dump the whole list.
7. If the page lists many professors, save each one.
8. Batch independent tool calls in the same turn.
9. Finish with a summary under 3 sentences.`;

  const writing = isZh
    ? `邮件写法：简体中文，200-350 字。结构：一句自我介绍（姓名/学校/专业/成绩排名）→ 两三句说明你为什么对他的具体方向感兴趣（引用读到的内容）→ 你能带来什么（竞赛/技能/科研经历里最相关的）→ 礼貌收尾，落款用姓名 + 院校 + 联系邮箱。`
    : `Email style: English, 200-350 words. Self-intro (name/school/major/GPA rank) → why this professor's specific work → what you bring (most relevant awards/skills/research) → polite close signed with name, school and contact email.`;

  return [
    persona,
    rules,
    writing,
    profileBlock(profile, isZh),
    isZh ? `导师库现状：\n${storeBrief}` : `Professor CRM:\n${storeBrief}`,
    pageContext
  ]
    .filter(Boolean)
    .join('\n\n');
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
 * @param {number}   opts.maxTokens  单轮输出预算（评价这类大 JSON 要放宽，否则参数会被截断）
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
  maxTokens,
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
        maxTokens,
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
        // 参数没解析出来（常见于输出被 max_tokens 截断）：回填错误让模型把参数写短重试，
        // 而不是让整轮任务失败
        if (call.argError) {
          result = {
            error: `工具参数解析失败：${call.argError}`,
            how_to_fix: '把这次提交写紧凑些再试：每条理由一句话（≤60 字）、每条依据只留 title 和 url、总结 ≤3 句。'
          };
        } else {
          const tool = toolMap.get(call.name);
          if (!tool) throw new Error(`没有名为 ${call.name} 的工具，可用工具：${[...toolMap.keys()].join(', ')}`);
          result = await tool.run(call.args || {});
        }
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
