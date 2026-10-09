// lib/review.js
// 研究方向评价：7 条轴 + 1 道闸门，按「导师评价维度.md」的约束实现。
//
// 这份文件是"评分口径"的唯一来源：轴的定义、四档判定锚点、检索动作、三种目标画像的
// 权重与基准多边形都在这里。提示词（buildReviewSystemPrompt）和界面（读同样的表）都从
// 这里生成，所以改口径只需要改这一处。
//
// 文档里的几条硬约束 → 代码里的对应实现：
//   1. 同向性：所有"越低越好"的量（内卷、延毕、门槛、垄断）都先翻转成
//      "友好度/可达性/弹性"再定档 —— 所以每轴的锚点直接写成"越高越好"的四档描述。
//   2. 主客观分层：基础匹配度是自评项（subjective），权重被 SUBJECTIVE_WEIGHT_CAP 封顶，
//      界面上单独标记，聚合分另外再给一个"仅客观项"的档位。
//   3. 权重随目标变：三个画像（读博 / 硕士就业 / 出国），各自带一条基准多边形。
//   4. 评分锚点：每轴写清 夯/稳/一般/拉 的判定标准，保证可复现。
//   5. 别装精确：对外只输出四档 + 一句人话解释 + 依据，不算小数分。
//   6. 边界：这里只评"研究方向"，导师人品/push 程度不在这张图上。
//   7. 资源可获得性做闸门：不足直接标红降级，不参与平均。

export const LEVELS = {
  strong: { zh: '夯', en: 'Strong', score: 5 },
  solid: { zh: '稳', en: 'Solid', score: 4 },
  fair: { zh: '一般', en: 'Fair', score: 3 },
  weak: { zh: '拉', en: 'Weak', score: 2 },
  unknown: { zh: '未知', en: 'No data', score: 0 }
};

// 自评项在任何画像里的权重上限（文档：混进总分时给主观项设权重上限）
export const SUBJECTIVE_WEIGHT_CAP = 0.15;

export const GATE_LEVELS = {
  ok: { zh: '充足', en: 'Sufficient', level: 'strong' },
  medium: { zh: '一般', en: 'Manageable', level: 'fair' },
  blocked: { zh: '不足', en: 'Blocked', level: 'weak' },
  unknown: { zh: '未知', en: 'No data', level: 'unknown' }
};

export const AXES = [
  {
    id: 'fit',
    short: { zh: '匹配', en: 'Fit' },
    label: { zh: '基础匹配度', en: 'Background fit' },
    measures: { zh: '知识重合度 − 转型成本', en: 'Overlap minus switching cost' },
    subjective: true, // 自评项：用学生画像和方向关键词比对得出
    proxies: { zh: '学生画像（课程/技能/科研经历）× 方向关键词', en: 'Student profile × direction keywords' },
    searchHints: {
      zh: [
        '先用 read_current_page / visit_page 拿到导师方向的准确关键词（主页、课题组页、近三年论文标题）',
        '把关键词和学生画像里的课程、技能、科研经历逐项比对，数出直接重合的项数',
        '查一眼该方向入门门槛（需要什么前置课程/工具），据此估转型成本'
      ],
      en: [
        'Get exact direction keywords from the homepage / lab page / recent paper titles',
        'Match them against the student profile items (courses, skills, research)',
        'Check the entry barrier (prerequisite courses/tools) to estimate switching cost'
      ]
    },
    anchors: {
      strong: { zh: '有 3 项以上直接重合（课程/技能/项目），几乎无转型成本', en: '3+ directly overlapping items, near-zero switching cost' },
      solid: { zh: '1-2 项直接重合，补 3-6 个月基础即可上手', en: '1-2 overlaps, 3-6 months of catch-up' },
      fair: { zh: '只有相邻领域的间接重合，需要半年到一年补课', en: 'Adjacent-field overlap only, 6-12 months of catch-up' },
      weak: { zh: '几乎没有重合，等于换方向重来', en: 'Almost no overlap — effectively starting over' }
    }
  },
  {
    id: 'momentum',
    short: { zh: '势能', en: 'Trend' },
    label: { zh: '成长势能', en: 'Growth momentum' },
    measures: { zh: '上升期 / 平台期 / 红海', en: 'Rising / plateau / ebbing' },
    objective: true,
    proxies: { zh: '论文数年曲线（DBLP、OpenAlex、Google Scholar）、NSFC 立项、搜索指数、融资', en: 'Publication-per-year curve, grants, search interest, funding' },
    searchHints: {
      zh: [
        'search_web：「<方向> site:dblp.org」或「<方向> papers 2023 2024 2025」看逐年论文量',
        'search_web：「<方向> 国家自然科学基金」看近三年立项数与金额',
        'search_web：「<方向> survey 2024 OR 2025」判断是不是仍在扩张期',
        '必要时 visit_page 打开 DBLP / OpenAlex 的检索结果页数年份'
      ],
      en: [
        'Search "<topic> papers 2023 2024 2025" or site:dblp.org for the per-year curve',
        'Search for recent grants/funding in the field',
        'Search "<topic> survey 2024 OR 2025" to see whether the field is still expanding',
        'visit_page DBLP/OpenAlex search pages to count papers per year'
      ]
    },
    anchors: {
      strong: { zh: '近三年论文量年增 >30%，或有基金/资本持续跟进', en: '>30% yearly publication growth, with grants/funding following' },
      solid: { zh: '论文量平稳、偶有热点，队伍没有收缩', en: 'Stable output, occasional hot spots' },
      fair: { zh: '增长停滞，主要靠既有成果维持', en: 'Growth stalled, sustained by existing work' },
      weak: { zh: '论文量连续下降，方向退潮或被并入其他领域', en: 'Declining output; field ebbing or being absorbed' }
    }
  },
  {
    id: 'industry',
    short: { zh: '产业', en: 'Industry' },
    label: { zh: '产业需求度', en: 'Industry demand' },
    measures: { zh: '毕业时点的岗位量与薪酬（硕/博分开看）', en: 'Job volume and pay at graduation (MSc vs PhD)' },
    objective: true,
    proxies: { zh: '招聘平台关键词岗位数、行业报告（信通院、IDC、Gartner）', en: 'Job-posting counts, industry reports' },
    searchHints: {
      zh: [
        'search_web：「<方向关键词> 招聘 岗位」看主流平台上的岗位量级',
        'search_web：「<方向> 行业报告 2025」找信通院/IDC/Gartner 等报告里的市场规模与增速',
        'search_web：「<方向> 硕士 薪资」与「<方向> 博士 去向」，硕博分开看'
      ],
      en: [
        'Search "<topic> jobs hiring" for posting volume',
        'Search "<topic> industry report 2025" for market size/growth',
        'Search salaries and destinations separately for MSc and PhD'
      ]
    },
    anchors: {
      strong: { zh: '岗位数量级大（千级以上）且薪酬明显高于同级平均', en: 'Large posting volume with clearly above-average pay' },
      solid: { zh: '岗位数中等，薪酬与同级平均持平', en: 'Moderate volume, average pay' },
      fair: { zh: '岗位偏少或集中在少数城市/公司', en: 'Few postings, concentrated in a few cities/companies' },
      weak: { zh: '岗位稀少且薪酬无溢价，多数要转岗', en: 'Scarce postings, no pay premium, most graduates switch roles' }
    }
  },
  {
    id: 'flexibility',
    short: { zh: '弹性', en: 'Flexibility' },
    label: { zh: '就业弹性', en: 'Career flexibility' },
    measures: { zh: '岗位宽度 + 技能可迁移性 − 转行成本', en: 'Job breadth + skill portability minus switching cost' },
    objective: true,
    proxies: { zh: '岗位 JD 技能词分布、跨行业去向统计', en: 'Skill keywords across job descriptions, cross-industry destinations' },
    searchHints: {
      zh: [
        'search_web：「<方向> 就业 去向」看毕业生去了哪些行业',
        'search_web：「<方向> JD 技能要求」对比不同岗位的技能词分布（比如算法/工程/产品）',
        'search_web：「<方向> 转行」看有没有成规模的转行路径'
      ],
      en: [
        'Search graduate destinations for the field',
        'Compare skill keywords across different job types (research/engineering/product)',
        'Look for established cross-industry transition paths'
      ]
    },
    anchors: {
      strong: { zh: '技能可迁移到 3 个以上行业，JD 技能词分布很宽', en: 'Skill set transfers to 3+ industries' },
      solid: { zh: '可迁移到 1-2 个邻近岗位方向', en: 'Transfers to 1-2 adjacent roles' },
      fair: { zh: '主要在同一个行业内换岗，跨行业需要额外补课', en: 'Mostly within one industry' },
      weak: { zh: '只有极窄的对口岗位，转行成本高', en: 'Very narrow job match; expensive to switch' }
    }
  },
  {
    id: 'ceiling',
    short: { zh: '天花板', en: 'Ceiling' },
    label: { zh: '学术天花板', en: 'Academic ceiling' },
    measures: { zh: '开放问题存量、方向宽度、长期可做性', en: 'Open problems, breadth, long-term viability' },
    objective: true,
    proxies: { zh: '近三年综述数量、顶会 track/workshop 变动、头部组在研方向', en: 'Recent surveys, top-venue track changes, leading labs' },
    searchHints: {
      zh: [
        'search_web：「<方向> survey 2024 OR 2025」——综述多且问题未收敛通常说明空间大',
        'search_web：「top conferences <方向> workshop 2025」看顶会是否还在新开 track',
        'search_web：「<方向> open problems」看有没有明确列出的开放问题清单',
        'visit_page 打开头部课题组的 research 页面，看在研方向是否还在延展'
      ],
      en: [
        'Search recent surveys — many surveys + unsettled problems usually means room',
        'Check whether top venues are still opening new tracks/workshops',
        'Search "<topic> open problems"',
        'Visit leading labs\' research pages'
      ]
    },
    anchors: {
      strong: { zh: '有明确且未解决的开放问题，近三年仍有多篇综述，头部组持续投入', en: 'Clear open problems, recent surveys, leading labs still investing' },
      solid: { zh: '问题基本清晰但细分空间有限，做扎实工作仍有机会', en: 'Reasonably clear problems with limited niches left' },
      fair: { zh: '主流问题被解决得差不多，得自己找边角问题', en: 'Mainstream problems mostly solved; only corners left' },
      weak: { zh: '方向已被吞并或收敛，博士期间难找到有意义的新问题', en: 'Field absorbed or converged; hard to find a meaningful PhD problem' }
    }
  },
  {
    id: 'achievability',
    short: { zh: '可达', en: 'Attainable' },
    label: { zh: '毕业可达性', en: 'Graduation attainability' },
    // 注意：原文的"延毕风险 / 资源依赖"是越低越好，这里已经翻转成"可达性"（越高越好）
    measures: { zh: '出成果周期、延毕风险、资源依赖（已翻转成可达性）', en: 'Time-to-result, delay risk, resource dependence (inverted)' },
    objective: true,
    proxies: { zh: '平均读博年限、实验/算力门槛、对平台的依赖度', en: 'Typical time-to-degree, compute/experiment barriers, platform dependence' },
    searchHints: {
      zh: [
        'search_web：「<方向> 博士 几年毕业」或「<方向> PhD time to degree」',
        'search_web：「<方向> 算力 需求 / 实验设备」判断普通组做不做得动',
        'search_web：「<方向> 延毕」看有没有成规模的抱怨/统计',
        'search_web：「<方向> 数据集 公开」——数据是否公开直接影响可达性'
      ],
      en: [
        'Search typical time-to-degree for the field',
        'Check compute/equipment requirements (can a normal group afford it?)',
        'Search for delay/attrition signals',
        'Check whether datasets are public'
      ]
    },
    anchors: {
      strong: { zh: '1-2 年能出成果，算力/设备门槛低，不依赖大平台', en: 'Results within 1-2 years, low resource barrier' },
      solid: { zh: '一般 2-3 年，需要一定资源但能解决', en: '2-3 years, moderate resources needed' },
      fair: { zh: '出成果周期偏长或依赖特定平台/数据', en: 'Longer cycle or platform/data dependence' },
      weak: { zh: '严重依赖稀缺资源，周期长、延毕风险高（普通组慎入）', en: 'Heavy resource dependence, long cycle, high delay risk' }
    }
  },
  {
    id: 'competition',
    short: { zh: '竞争', en: 'Competition' },
    label: { zh: '竞争友好度', en: 'Competition friendliness' },
    // 内卷度/垄断度越低越好 → 已翻转成"友好度"
    measures: { zh: '内卷度、审稿友好度、垄断程度（已翻转成友好度）', en: 'Crowding, review friendliness, monopolisation (inverted)' },
    objective: true,
    proxies: { zh: '顶会投稿量/录取率、同方向活跃组数、企业研究院产出占比', en: 'Submission/acceptance rates, number of active groups, industry-lab share' },
    searchHints: {
      zh: [
        'search_web：「<顶会> 投稿量 录取率 2025」看近三年趋势',
        'search_web：「<方向> 课题组」数一数活跃组数量级',
        'search_web：「<方向> 大厂 研究院 论文」看企业研究院是否垄断了产出'
      ],
      en: [
        'Check submission/acceptance trends at the main venue',
        'Count how many groups are active in the area',
        'See whether industry labs dominate the output'
      ]
    },
    anchors: {
      strong: { zh: '活跃组不多、审稿相对友好、企业研究院占比低', en: 'Few active groups, friendly review, low industry-lab share' },
      solid: { zh: '有一定内卷但可接受，新人仍能拿到位置', en: 'Some crowding but newcomers still get in' },
      fair: { zh: '明显内卷：投稿量大、录取率低，需要强背景', en: 'Clearly crowded: high submissions, low acceptance' },
      weak: { zh: '极度内卷且被少数巨头垄断产出，新人很难露头', en: 'Extremely crowded and monopolised by a few giants' }
    }
  }
];

// 闸门：资源可获得性。不达标直接标红，不参与平均（文档明确要求）
export const RESOURCE_GATE = {
  id: 'resources',
  label: { zh: '资源可获得性（闸门）', en: 'Resource availability (gate)' },
  note: {
    zh: '算力 / 数据 / 设备 / 经费是否够普通组做这个方向。不足会标红降级，不参与平均。',
    en: 'Compute/data/equipment/funding for a normal group. Blocked results are flagged, not averaged.'
  },
  searchHints: {
    zh: [
      'search_web：「<方向> 算力 需求 GPU 数量」看训练/推理门槛',
      'search_web：「<方向> 数据集 公开 获取」数据是否公开可得',
      'search_web：「<方向> 实验设备 成本」是否需要昂贵设备',
      'search_web：「<方向> 经费 项目」看是否有适合普通课题组的经费渠道'
    ],
    en: [
      'Check compute requirements (GPUs needed)',
      'Check whether datasets are public',
      'Check equipment cost',
      'Check available funding routes for a normal group'
    ]
  },
  anchors: {
    strong: { zh: '算力/数据/设备都容易获得，普通组做得动', en: 'Compute, data and equipment are all accessible' },
    solid: { zh: '需要一定投入但可解决（组内或校内资源够）', en: 'Some investment needed but solvable' },
    fair: { zh: '需要外部平台或较难申请的经费，周期长', en: 'Needs external platform or hard-to-get funding' },
    weak: { zh: '离不开大平台/大经费，普通组做不动', en: 'Requires a big platform/budget — not viable for a normal group' }
  }
};

// 目标画像：权重 + 基准多边形（蛛网图上叠的那条"你的目标画像"）
export const PROFILES = {
  phd: {
    label: { zh: '读博 / 保研', en: 'PhD track' },
    hint: { zh: '看天花板和竞争友好度，产业需求只是兜底', en: 'Weighs ceiling and competition; industry is a fallback' },
    weights: { ceiling: 0.25, competition: 0.2, momentum: 0.18, achievability: 0.15, fit: 0.12, industry: 0.05, flexibility: 0.05 },
    baseline: { fit: 'solid', momentum: 'solid', industry: 'weak', flexibility: 'weak', ceiling: 'strong', achievability: 'solid', competition: 'solid' }
  },
  master: {
    label: { zh: '硕士就业', en: 'Master → industry' },
    hint: { zh: '产业需求、就业弹性、毕业可达性优先', en: 'Prioritises industry demand, flexibility, attainability' },
    weights: { industry: 0.25, flexibility: 0.22, achievability: 0.18, momentum: 0.12, fit: 0.1, competition: 0.08, ceiling: 0.05 },
    baseline: { fit: 'solid', momentum: 'fair', industry: 'strong', flexibility: 'strong', ceiling: 'weak', achievability: 'solid', competition: 'fair' }
  },
  overseas: {
    label: { zh: '出国申请', en: 'Overseas application' },
    hint: { zh: '学术天花板、势能与竞争友好度并重', en: 'Ceiling, momentum and competition all matter' },
    weights: { ceiling: 0.25, momentum: 0.2, competition: 0.18, fit: 0.12, achievability: 0.1, industry: 0.08, flexibility: 0.07 },
    baseline: { fit: 'solid', momentum: 'solid', industry: 'fair', flexibility: 'fair', ceiling: 'strong', achievability: 'solid', competition: 'solid' }
  }
};

export const DEFAULT_PROFILE = 'phd';
export const REVIEW_MAX_STEPS = 18; // 7 条轴 + 闸门都要搜，步数比写邮件多

const LEVEL_ALIASES = new Map();
for (const [key, def] of Object.entries(LEVELS)) {
  LEVEL_ALIASES.set(key, key);
  LEVEL_ALIASES.set(def.zh, key);
  LEVEL_ALIASES.set(def.en.toLowerCase(), key);
}
LEVEL_ALIASES.set('高', 'strong');
LEVEL_ALIASES.set('低', 'weak');
LEVEL_ALIASES.set('中', 'fair');
LEVEL_ALIASES.set('5', 'strong');
LEVEL_ALIASES.set('4', 'solid');
LEVEL_ALIASES.set('3', 'fair');
LEVEL_ALIASES.set('2', 'weak');
LEVEL_ALIASES.set('1', 'weak');

export function normalizeLevel(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!text) return null;
  return LEVEL_ALIASES.get(text) || LEVEL_ALIASES.get(text.toLowerCase()) || null;
}

// 闸门是"充足 / 一般 / 不足 / 未知"四档，和轴的档位不是同一套词，单独归一化
const GATE_ALIASES = new Map();
for (const [key, def] of Object.entries(GATE_LEVELS)) {
  GATE_ALIASES.set(key, key);
  GATE_ALIASES.set(def.zh, key);
  GATE_ALIASES.set(def.en.toLowerCase(), key);
}
GATE_ALIASES.set('strong', 'ok');
GATE_ALIASES.set('solid', 'ok');
GATE_ALIASES.set('fair', 'medium');
GATE_ALIASES.set('weak', 'blocked');
GATE_ALIASES.set('够', 'ok');
GATE_ALIASES.set('不够', 'blocked');

export function normalizeGateLevel(raw) {
  if (raw == null) return 'unknown';
  const text = String(raw).trim();
  return GATE_ALIASES.get(text) || GATE_ALIASES.get(text.toLowerCase()) || 'unknown';
}

export function gateLabel(key, lang = 'zh') {
  const def = GATE_LEVELS[key];
  return def ? def[lang] || def.zh : String(key ?? '');
}

// 闸门档位 → 对应的四档色调（用于着色）
export function gateTone(key) {
  return GATE_LEVELS[key]?.level || 'unknown';
}

export function levelLabel(level, lang = 'zh') {
  const def = LEVELS[level];
  return def ? def[lang] || def.zh : String(level ?? '');
}

export function levelScore(level) {
  return LEVELS[level]?.score ?? 0;
}

function normalizeEvidence(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === 'string') return { title: item.slice(0, 160), url: '', note: '' };
      return {
        title: String(item?.title || item?.source || '').trim().slice(0, 160),
        url: String(item?.url || '').trim().slice(0, 400),
        note: String(item?.note || item?.finding || '').trim().slice(0, 200)
      };
    })
    .filter((item) => item.title || item.url || item.note)
    .slice(0, 3);
}

// 校验模型提交的评价：7 条轴齐全、档位合法、给了档位就必须有依据。
// 不齐全就返回 issues，工具会把它回填给模型让它继续搜（这是"必须搜到数据"的强制点）。
export function validateReview(input = {}) {
  const issues = [];
  const rawAxes = Array.isArray(input.axes) ? input.axes : [];
  const axes = [];

  for (const def of AXES) {
    const raw = rawAxes.find((item) => {
      const id = String(item?.id || item?.axis || '').trim().toLowerCase();
      const label = String(item?.label || item?.name || '').trim();
      return id === def.id || id === def.short.en.toLowerCase() || label === def.label.zh || label === def.label.en;
    });

    if (!raw) {
      issues.push(`缺少维度「${def.label.zh}」`);
      continue;
    }
    const level = normalizeLevel(raw.level ?? raw.score ?? raw.grade);
    if (!level) {
      issues.push(`「${def.label.zh}」的档位无效（只能填 夯/稳/一般/拉/未知）：${raw.level ?? raw.score}`);
      continue;
    }
    const evidence = normalizeEvidence(raw.evidence ?? raw.sources);
    if (level !== 'unknown' && !evidence.length) {
      issues.push(`「${def.label.zh}」给了「${levelLabel(level)}」却没有任何依据，请先搜索后补上来源，或改成未知`);
    }
    axes.push({
      id: def.id,
      level,
      reason: String(raw.reason || raw.explanation || '').trim().slice(0, 240),
      evidence
    });
  }

  const rawGate = input.gate || input.resource_gate || {};
  const gate = {
    level: normalizeGateLevel(rawGate.level ?? rawGate.status),
    reason: String(rawGate.reason || rawGate.explanation || '').trim().slice(0, 400),
    evidence: normalizeEvidence(rawGate.evidence ?? rawGate.sources)
  };

  const profile = String(input.target_profile || input.profile || '').trim().toLowerCase();
  const targetProfile = PROFILES[profile] ? profile : DEFAULT_PROFILE;

  const review = {
    axes,
    gate,
    targetProfile,
    conclusion: String(input.conclusion || input.summary || '').trim().slice(0, 600),
    reviewedAt: Date.now()
  };

  return { ok: issues.length === 0, issues, review };
}

// 按目标画像算加权档位。自评项权重先封顶再重新归一化，保证量纲不变。
export function aggregate(review, profileId = review?.targetProfile) {
  const profile = PROFILES[profileId] || PROFILES[DEFAULT_PROFILE];
  const byId = new Map((review?.axes || []).map((axis) => [axis.id, axis]));

  let weightSum = 0;
  let scoreSum = 0;
  let known = 0;
  let objectiveWeight = 0;
  let objectiveScore = 0;

  for (const def of AXES) {
    const entry = byId.get(def.id);
    const score = entry ? levelScore(entry.level) : 0;
    if (score > 0) known += 1;

    let weight = profile.weights[def.id] ?? 0;
    if (def.subjective) weight = Math.min(weight, SUBJECTIVE_WEIGHT_CAP);
    if (score <= 0) continue; // 未知项不计入

    weightSum += weight;
    scoreSum += weight * score;
    if (!def.subjective) {
      objectiveWeight += weight;
      objectiveScore += weight * score;
    }
  }

  const score = weightSum ? scoreSum / weightSum : 0;
  const objective = objectiveWeight ? objectiveScore / objectiveWeight : 0;

  const baseLevel = scoreToLevel(score);
  const gateBlocked = (review?.gate?.level || 'unknown') === 'blocked';

  return {
    profile: profileId,
    // 闸门不达标：整体降一档（文档要求别让资源问题被其他高分平均掉）
    level: gateBlocked ? downgradeLevel(baseLevel) : baseLevel,
    rawLevel: baseLevel,
    objectiveLevel: objective ? scoreToLevel(objective) : 'unknown',
    score,
    coverage: { known, total: AXES.length },
    gate: review?.gate?.level || 'unknown',
    gateTone: gateTone(review?.gate?.level || 'unknown'),
    downgraded: gateBlocked
  };
}

export function downgradeLevel(level) {
  if (level === 'strong') return 'solid';
  if (level === 'solid') return 'fair';
  if (level === 'fair') return 'weak';
  return 'weak';
}

export function scoreToLevel(score) {
  if (!score) return 'unknown';
  if (score >= 4.5) return 'strong';
  if (score >= 3.5) return 'solid';
  if (score >= 2.5) return 'fair';
  return 'weak';
}

// ─── 提示词 ─────────────────────────────────────────────────────────────────
function anchorsBlock(lang) {
  const isZh = lang !== 'en';
  const lines = [isZh ? '评分锚点（必须按这个判，保证可复现）：' : 'Scoring anchors (use these):'];
  for (const axis of AXES) {
    lines.push(`【${axis.label[lang] || axis.label.zh}】${isZh ? '（自评项）' : ''}`.trim());
    for (const level of ['strong', 'solid', 'fair', 'weak']) {
      lines.push(`  ${levelLabel(level, lang)}：${axis.anchors[level][lang] || axis.anchors[level].zh}`);
    }
  }
  lines.push(`【${RESOURCE_GATE.label[lang] || RESOURCE_GATE.label.zh}】`);
  for (const level of ['strong', 'solid', 'fair', 'weak']) {
    lines.push(`  ${levelLabel(level, lang)}：${RESOURCE_GATE.anchors[level][lang] || RESOURCE_GATE.anchors[level].zh}`);
  }
  return lines.join('\n');
}

function searchPlaybook(lang) {
  const isZh = lang !== 'en';
  const lines = [isZh ? '每个维度先去搜，搜到再定档（建议动作）：' : 'Search before scoring (suggested moves):'];
  for (const axis of AXES) {
    lines.push(`【${axis.label[lang] || axis.label.zh}】`);
    for (const hint of axis.searchHints[lang] || axis.searchHints.zh) lines.push(`  - ${hint}`);
  }
  lines.push(
    `【${RESOURCE_GATE.label[lang] || RESOURCE_GATE.label.zh}】`
  );
  for (const hint of RESOURCE_GATE.searchHints[lang] || RESOURCE_GATE.searchHints.zh) lines.push(`  - ${hint}`);
  return lines.join('\n');
}

export function buildReviewSystemPrompt({ lang = 'zh', professor = {}, profileId = DEFAULT_PROFILE, storeBrief = '' }) {
  const isZh = lang !== 'en';
  const profile = PROFILES[profileId] || PROFILES[DEFAULT_PROFILE];

  const intro = isZh
    ? `你是研究方向评估员。学生想联系一位导师，你要评估的是【这个研究方向值不值得投入】——
不是评价导师本人（人品、push 程度、横向多少属于另一张图，不要写进这里）。

7 条轴（已经在代码里统一成"越高越好"，你只需要按锚点定档）：
${AXES.map((axis) => `- ${axis.label.zh}：${axis.measures.zh}（可查：${axis.proxies.zh}）`).join('\n')}
- 资源可获得性：闸门，不是轴。不足就标红降级。`
    : `You are a research-direction evaluator. You score whether the DIRECTION is worth investing in —
not the professor as a person.
Axes (all pre-oriented so higher is better):
${AXES.map((axis) => `- ${axis.label.en}：${axis.measures.en} (proxies: ${axis.proxies.en})`).join('\n')}
- Resource availability: a gate, not an axis.`;

  const rules = isZh
    ? `铁律：
1. 每条轴都必须先联网搜索，用搜到的具体事实支撑档位；不许凭印象定档。7 条轴 + 闸门至少各搜 1 次，多数轴需要 2 次以上。
2. 档位只有五选一：夯 / 稳 / 一般 / 拉 / 未知。给了档位就必须附依据（标题 + 链接 + 你看到的关键事实）；真的搜不到才填"未知"。
3. 所有"越低越好"的量（内卷度、延毕率、门槛、垄断度）都已经在锚点里翻转成"友好度/可达性/弹性"，你直接按锚点判，不要自己反过来。
4. 基础匹配度是自评项：拿"学生画像"里的课程、技能、科研经历和导师方向关键词逐项比对，写清重合了哪些、要补什么。它是推断，不要当成搜到的事实。
5. 资源可获得性只做闸门：算力/数据/设备/经费不够普通组用，就填"不足"。
6. 只用四档 + 一句人话解释 + 依据，不要编造精确分数。
7. 提交要紧凑，否则参数会被输出长度截断导致提交失败：每条轴的 reason 一句话（≤60 字），
   每条 evidence 只写 title + url + 一句 ≤50 字的关键事实（每轴最多 2 条），总结 ≤3 句。
8. 最后用 3 句以内总结：这个方向适合什么目标的人，以及最大的风险点是什么。`
    : `Hard rules:
1. Search the web for every axis; never score from memory. At least one search per axis (usually two+).
2. Levels: Strong / Solid / Fair / Weak / No data. A level other than "No data" requires evidence (title + link + the key fact you saw).
3. All "lower is better" quantities are already inverted in the anchors — follow them as written.
4. Background fit is self-assessed: compare the student profile against the direction keywords.
5. Resource availability is a gate only.
6. Four coarse levels + one plain sentence, no fake precision.
7. Keep the submission compact or it will be truncated by the output limit: one sentence per reason, evidence as title + url + one short fact (max 2 per axis), summary under 3 sentences.
8. Finish with a 3-sentence summary: who this direction fits and the biggest risk.`;

  const who = isZh
    ? `评估对象：
- 导师：${professor.name || '（未知）'}${professor.school ? ` @${professor.school}` : ''}
- 方向关键词：${(professor.tags || []).join('、') || '（库里还没有，先用 read_current_page / search_web 找出来）'}
- 方向摘要：${professor.summary || '（无）'}
- 主页：${professor.homepageUrl || '（无）'}

当前目标画像：${profile.label.zh}（${profile.hint.zh}）
导师库现状：
${storeBrief}

提交方式：把结果通过 save_review 工具提交（档位、理由、依据链接一起给），不要只在正文里写。`
    : `Target:
- Professor: ${professor.name || '(unknown)'}${professor.school ? ` @${professor.school}` : ''}
- Keywords: ${(professor.tags || []).join(', ') || '(none yet — find them first)'}
- Summary: ${professor.summary || '(none)'}
- Homepage: ${professor.homepageUrl || '(none)'}

Target profile: ${profile.label.en} (${profile.hint.en})
CRM:
${storeBrief}

Submit via the save_review tool.`;

  return [intro, rules, anchorsBlock(lang), searchPlaybook(lang), who].join('\n\n');
}

export function buildReviewTask({ lang = 'zh', professor = {} } = {}) {
  const isZh = lang !== 'en';
  const name = professor.name || (isZh ? '这位导师' : 'this professor');
  return isZh
    ? `请评价${name}的研究方向：7 条轴逐条联网搜索后定档（夯/稳/一般/拉，搜不到才填未知），给出依据链接；再判断资源可获得性闸门；最后总结这个方向适合什么目标的人。信息不足时先读当前页面或搜索补齐关键词。`
    : `Evaluate the research direction of ${name}: search the web for each of the 7 axes, assign a level (Strong/Solid/Fair/Weak, only "No data" if truly nothing found) with evidence links, judge the resource gate, and summarise who this direction fits.`;
}
