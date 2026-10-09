// lib/radar.js
// 蛛网图（雷达图）生成：纯函数输出 SVG 字符串，不依赖任何图表库，也不依赖 DOM —— 所以能单测。
//
// 按维度文档的要求画三层：
//   1. 评分多边形（7 条轴，全部已同向处理成"越高越好"）
//   2. 目标画像的基准多边形（虚线，一眼看出差距）
//   3. 自评项 / 无数据的顶点用不同颜色标出（主客观分层、别装精确）
//
// 半径刻度就是四档：夯=最外圈、稳、一般、拉=第 2 圈（第 1 圈留着给"无数据"归零）。

import { AXES, LEVELS, levelLabel, levelScore } from './review.js';

// 每一圈的档位（从外到内）：5/5 位置=夯，4=稳，3=一般，2=拉
export const RING_LEVELS = [5, 4, 3, 2];

const round = (n) => Math.round(n * 10) / 10;

export function axisAngle(index, total = AXES.length) {
  return -Math.PI / 2 + (index * 2 * Math.PI) / total; // 从正上方开始，顺时针
}

export function axisPoint(index, score, { size, radius, cx, cy, total = AXES.length } = {}) {
  const angle = axisAngle(index, total);
  const r = radius * (Math.max(0, Math.min(5, score)) / 5);
  return [round(cx + r * Math.cos(angle)), round(cy + r * Math.sin(angle))];
}

function polygonPoints(scores, geom) {
  return scores.map((score, i) => axisPoint(i, score, geom).join(',')).join(' ');
}

/**
 * 生成蛛网图 SVG。
 * @param {object} review    validateReview() 产出的评价（含 axes[{id, level}]）
 * @param {object} baseline  { [axisId]: level } 目标画像基准，可省略
 * @param {number} size      SVG 边长
 * @param {string} lang      'zh' | 'en'
 */
export function buildRadarSvg({ review, baseline, size = 320, lang = 'zh' } = {}) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2 - 42; // 留出轴标签的空间
  const geom = { size, radius, cx, cy };

  const byId = new Map((review?.axes || []).map((axis) => [axis.id, axis]));
  const scores = AXES.map((def) => levelScore(byId.get(def.id)?.level || 'unknown'));
  const baselineScores = AXES.map((def) => (baseline?.[def.id] ? levelScore(baseline[def.id]) : 0));

  const parts = [];
  parts.push(
    `<svg class="radar" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="研究方向评价蛛网图">`
  );

  // 1) 网格：每一档一圈
  for (const ring of RING_LEVELS) {
    const points = polygonPoints(AXES.map(() => ring), geom);
    parts.push(`<polygon class="radar-grid" points="${points}" fill="none" stroke="var(--border,#ddd8cf)" stroke-width="1"/>`);
  }

  // 2) 轴线
  AXES.forEach((def, i) => {
    const [x, y] = axisPoint(i, 5, geom);
    const unknown = !levelScore(byId.get(def.id)?.level || 'unknown');
    parts.push(
      `<line class="radar-axis${unknown ? ' is-unknown' : ''}" x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border,#ddd8cf)" stroke-width="1"${unknown ? ' stroke-dasharray="3 3"' : ''}/>`
    );
  });

  // 3) 目标画像基准多边形（虚线）
  if (baseline && baselineScores.some((s) => s > 0)) {
    parts.push(
      `<polygon class="radar-baseline" points="${polygonPoints(baselineScores, geom)}" fill="none" stroke="var(--ink-light,#8a8680)" stroke-width="1.2" stroke-dasharray="5 4"/>`
    );
  }

  // 4) 评分多边形
  parts.push(
    `<polygon class="radar-score" points="${polygonPoints(scores, geom)}" fill="var(--accent,#c0392b)" fill-opacity="0.16" stroke="var(--accent,#c0392b)" stroke-width="1.8" stroke-linejoin="round"/>`
  );

  // 5) 顶点：自评项用琥珀色、无数据用空心灰圈
  AXES.forEach((def, i) => {
    const level = byId.get(def.id)?.level || 'unknown';
    const score = levelScore(level);
    const [x, y] = axisPoint(i, score, geom);
    if (!score) {
      parts.push(`<circle class="radar-vertex unknown" cx="${x}" cy="${y}" r="4" fill="none" stroke="var(--ink-light,#8a8680)" stroke-width="1.4"/>`);
    } else if (def.subjective) {
      parts.push(`<circle class="radar-vertex subjective" cx="${x}" cy="${y}" r="3.6" fill="var(--subjective,#b45309)" stroke="#fff" stroke-width="1"/>`);
    } else {
      parts.push(`<circle class="radar-vertex" cx="${x}" cy="${y}" r="3" fill="var(--accent,#c0392b)"/>`);
    }
  });

  // 6) 每圈的档位标签（沿正上方那条线内侧排）
  for (const ring of RING_LEVELS) {
    const [x, y] = axisPoint(0, ring, geom);
    parts.push(
      `<text class="radar-ring-label" x="${round(x + 4)}" y="${round(y + 8)}" font-size="8.5" fill="var(--ink-light,#8a8680)" font-family="monospace">${levelLabel(ringToLevel(ring), lang)}</text>`
    );
  }

  // 7) 轴名（放在最外圈之外）
  AXES.forEach((def, i) => {
    const [x, y] = axisPoint(i, 5.9, geom);
    const angle = axisAngle(i);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const anchor = cos > 0.35 ? 'start' : cos < -0.35 ? 'end' : 'middle';
    const dy = sin > 0.6 ? 7 : sin < -0.6 ? -2 : 3.5;
    const level = byId.get(def.id)?.level || 'unknown';
    const cls = level === 'unknown' ? 'radar-axis-label is-unknown' : def.subjective ? 'radar-axis-label is-subjective' : 'radar-axis-label';
    const fill = level === 'unknown'
      ? 'var(--ink-light,#8a8680)'
      : def.subjective
        ? 'var(--subjective,#b45309)'
        : 'var(--ink,#1a1814)';
    parts.push(
      `<text class="${cls}" x="${round(x)}" y="${round(y + dy)}" font-size="10.5" text-anchor="${anchor}" fill="${fill}">${escapeXml(def.short[lang] || def.short.zh)}</text>`
    );
  });

  parts.push('</svg>');
  return parts.join('');
}

function ringToLevel(score) {
  if (score >= 5) return 'strong';
  if (score >= 4) return 'solid';
  if (score >= 3) return 'fair';
  return 'weak';
}

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 供图例使用：把一条轴的颜色语义集中在一处
export function axisColorKind(def, level) {
  if (!levelScore(level)) return 'unknown';
  return def.subjective ? 'subjective' : 'objective';
}

export { LEVELS };
