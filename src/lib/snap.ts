/**
 * 镜头切点吸附：给定一组镜头切点（HH:MM:SS,mmm，每行一个），对距离切点不
 * 超过阈值的字幕边界，用全局动态规划选择“吸附到切点”或“保留原位”，在
 * 保持顺序、相邻字幕不重叠且每条不短于可调最小时长的前提下，按字典序
 * 依次最小化：① 跨镜头字幕数（内部含切点的条数）；② 边界总位移（ms）；
 * ③ 改动条数（时间发生变化的条数）。
 *
 * - 候选位置：每个边界可保留原位，或吸附到与原边界距离 ≤ 阈值、且位于
 *   原区间内侧的切点（开始只可右移、结束只可左移——吸附不越过原区间、
 *   不挤占相邻空隙，因此部分采纳也不会制造新的重叠）。切点恰落在原边
 *   界上时视为命中，位移 0、不算改动。
 * - 动态规划：以前一条结束时间（候选位置）为状态，枚举当前条
 *   (开始, 结束) 候选对，要求 结束 − 开始 ≥ 最小时长且开始不早于前一条
 *   结束；两侧候选均按时间有序，归并取前缀字典序最优转移，
 *   时间复杂度 O(n·k²)（n 为条数、k 为单边界候选数）。
 * - 无解：上游本身存在时长非正的条、相邻重叠（保留原位即冲突）或某条
 *   原时长已短于最小时长时，吸附只能内收无法修复，标记不可解并给出原
 *   因，全部保持原时间。
 * - 采纳：以条为单位采纳/恢复；key 由 groupIndex 与吸附后时间构成，
 *   切点、参数或上游结果变化导致方案不同时，旧采纳自动失效。
 */
import type { MergedCue } from './merge';
import { formatTimecode, parseTimecode } from './srt';

export interface SnapOptions {
  /** 吸附阈值：边界与切点距离（毫秒）不超过该值才可吸附 */
  thresholdMs: number;
  /** 每条字幕吸附后的最短时长（毫秒） */
  minDurMs: number;
}

export const DEFAULT_SNAP_OPTIONS: SnapOptions = {
  thresholdMs: 1500,
  minDurMs: 800,
};

/** 单个边界（开始/结束）的候选位置及该侧吸附后消除的切点数。 */
interface BoundCandidate {
  /** 候选边界时间（毫秒） */
  pos: number;
  /** 是否移动（保留原位为 false；原位恰为切点时仍是 false） */
  moved: boolean;
  /** 命中切点；保留原位且恰好落在切点上时同样填写 */
  cut: number | null;
  /** 与原边界的位移（毫秒，非负） */
  dist: number;
}

export interface SnapBoundary {
  /** 原边界时间（毫秒） */
  from: number;
  /** 新边界时间（毫秒；不可解或保留原位时等于 from） */
  to: number;
  /** 位移（毫秒，非负） */
  dist: number;
  /** 命中的切点（保留原位且落在切点上也算命中） */
  hitCut: number | null;
  /** 是否实际移动 */
  moved: boolean;
  /** 未吸附原因（空串表示已吸附或原位即命中切点） */
  reason: string;
}

export interface SnapItem {
  /** cue 下标 */
  index: number;
  /** 稳定标识：groupIndex 与吸附后时间构成；切点/参数/上游变化即失效 */
  key: string;
  start: SnapBoundary;
  end: SnapBoundary;
  /** 原区间内部（严格介于开始与结束之间）的切点数 */
  cutsBefore: number;
  /** 新区间内部的切点数 */
  cutsAfter: number;
  /** 该条是否仍跨镜头（新时间下内部含切点） */
  crossesAfter: boolean;
  /** 时间是否发生变化 */
  changed: boolean;
}

export interface CutParseIssue {
  line: number;
  raw: string;
  kind: 'invalid' | 'duplicate';
  message: string;
}

export interface ParsedCuts {
  /** 去重并升序排列的切点（毫秒） */
  cuts: number[];
  issues: CutParseIssue[];
}

const CUT_LINE_RE = /(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3})/;

/** 解析切点列表：每行一个 HH:MM:SS,mmm（允许行内空白与 SRT 式序号），重复切点只保留首个。 */
export function parseCutList(text: string): ParsedCuts {
  const issues: CutParseIssue[] = [];
  const seen = new Set<number>();
  const cuts: number[] = [];
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((rawLine, li) => {
    const line = rawLine.trim();
    if (!line) return;
    if (/^\d+$/.test(line)) return; // SRT 式序号行
    const m = line.match(CUT_LINE_RE);
    const ms = m ? parseTimecode(m[1]) : null;
    if (ms === null) {
      issues.push({
        line: li + 1,
        raw: rawLine,
        kind: 'invalid',
        message: `第 ${li + 1} 行无法识别为 HH:MM:SS,mmm 时间：${line}`,
      });
      return;
    }
    if (seen.has(ms)) {
      issues.push({
        line: li + 1,
        raw: rawLine,
        kind: 'duplicate',
        message: `第 ${li + 1} 行切点 ${formatTimecode(ms)} 重复，已忽略`,
      });
      return;
    }
    seen.add(ms);
    cuts.push(ms);
  });
  cuts.sort((a, b) => a - b);
  return { cuts, issues };
}

function normOptions(o: SnapOptions): SnapOptions {
  const thresholdMs = Math.max(
    0,
    Math.round(Number.isFinite(o.thresholdMs) ? o.thresholdMs : DEFAULT_SNAP_OPTIONS.thresholdMs),
  );
  const minDurMs = Math.max(
    1,
    Math.round(Number.isFinite(o.minDurMs) ? o.minDurMs : DEFAULT_SNAP_OPTIONS.minDurMs),
  );
  return { thresholdMs, minDurMs };
}

/** 二分：严格小于 t 的切点数。 */
function countBelow(cuts: number[], t: number): number {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 严格位于 (lo, hi) 内的切点数。 */
function cutsBetween(cuts: number[], lo: number, hi: number): number {
  return countBelow(cuts, hi) - countBelow(cuts, lo + 1);
}

/**
 * 构建某侧边界的候选位置（按时间升序，末位为保留原位）。
 * 开始侧只接受不早于原位的切点（右移内收），结束侧只接受不晚于原位的
 * 切点（左移内收）；切点不得抵达/越过对侧原边界（时长非正）。
 */
function boundaryCandidates(
  orig: number,
  side: 'start' | 'end',
  far: number,
  cuts: number[],
  opts: SnapOptions,
): BoundCandidate[] {
  const cands: BoundCandidate[] = [];
  for (const c of cuts) {
    const dist = Math.abs(c - orig);
    if (dist > opts.thresholdMs || dist === 0) continue;
    if (side === 'start' ? c < orig : c > orig) continue; // 只内收
    if (side === 'start' ? c >= far : c <= far) continue; // 不得越过对侧原边界
    cands.push({ pos: c, moved: true, cut: c, dist });
  }
  // 保留原位（恰落在切点上时记录命中，位移 0、不算改动）
  const k = countBelow(cuts, orig);
  const atCut = cuts[k] === orig ? orig : null;
  cands.push({ pos: orig, moved: false, cut: atCut, dist: 0 });
  cands.sort((a, b) => a.pos - b.pos || Number(b.moved) - Number(a.moved));
  return cands;
}

/** 候选列表中的“保留原位”项（boundaryCandidates 保证其存在）。 */
function stayCandidate(cands: BoundCandidate[]): BoundCandidate {
  return cands.find((c) => !c.moved) ?? cands[cands.length - 1];
}

/** 字典序目标：(跨镜头数, 总位移, 改动条数)；Infinity 表示不可行。 */
type Cost = readonly [number, number, number];
const INF: Cost = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];

const better = (a: Cost, b: Cost): boolean =>
  a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
const add = (a: Cost, b: Cost): Cost => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

export interface SnapAnalysis {
  /** 切点总数（去重后） */
  cutCount: number;
  /** 是否存在全局可行方案 */
  ok: boolean;
  /** 不可行总原因（ok 时为空串） */
  reason: string;
  /** 逐条吸附结果（不可解时新时间等于原时间并附原因） */
  items: SnapItem[];
  /** 原时间下跨镜头字幕数 */
  crossingBefore: number;
  /** 方案后跨镜头字幕数（不可解时等于 crossingBefore） */
  crossingCues: number;
  /** 边界总位移 ms（不可解时为 0） */
  totalShiftMs: number;
  /** 改动条数（不可解时为 0） */
  changedCues: number;
}

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`;

/** 前置体检：保留原位即违反约束、吸附（只能内收）无法修复的情形。 */
function preCheck(cues: MergedCue[], opts: SnapOptions): Map<number, string> {
  const bad = new Map<number, string>();
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (c.end <= c.start) {
      bad.set(
        i,
        `该条结束时间（${formatTimecode(c.end)}）不晚于开始时间（${formatTimecode(c.start)}），上游时间非法`,
      );
      continue;
    }
    if (c.end - c.start < opts.minDurMs) {
      bad.set(
        i,
        `原时长仅 ${fmtSec(c.end - c.start)}，已短于最短时长 ${fmtSec(opts.minDurMs)}，吸附只能内收、无法延长`,
      );
    }
    if (i > 0 && c.start < cues[i - 1].end) {
      const prev = bad.get(i);
      bad.set(
        i,
        prev
          ? `${prev}；且原时间早于上一条结束（${formatTimecode(cues[i - 1].end)}），存在既有重叠`
          : `原时间早于上一条结束（${formatTimecode(cues[i - 1].end)}），上游存在时间重叠，吸附只能内收、无法外推解冲突`,
      );
    }
  }
  return bad;
}

interface Layer {
  /** bestFromS[s]：达到 S[s] 的最优前缀来自上一层哪个结束候选 */
  bestFromS: number[];
  /** backS[e]：结束取 E[e] 时最优搭配的开始候选下标（-1 不可行） */
  backS: number[];
  curCost: Cost[];
}

export interface CueCandidates {
  S: BoundCandidate[];
  E: BoundCandidate[];
}

/**
 * 全局动态规划：在顺序、不重叠、最短时长约束下，按
 * (跨镜头字幕数, 边界总位移, 改动条数) 字典序求全局最优吸附方案。
 */
function solve(
  perCue: CueCandidates[],
  cuts: number[],
  opts: SnapOptions,
  bad: ReadonlyMap<number, string>,
): { sChosen: number[]; eChosen: number[] } | null {
  if (bad.size > 0) return null;
  const n = perCue.length;

  // 虚拟“第 -1 条结束于 -∞”，保证第一条任意开始候选可行
  let prevPos: number[] = [-Infinity];
  let prevCost: Cost[] = [[0, 0, 0]];
  const layers: Layer[] = [];

  for (let i = 0; i < n; i++) {
    const { S, E } = perCue[i];

    // 归并：prevPos 与 S 均升序；bestS[s] = 所有 prevEnd ≤ S[s] 中代价最小者
    const bestCost: Cost[] = S.map(() => INF);
    const bestFromS: number[] = S.map(() => -1);
    let j = 0;
    let bestCostVal: Cost = INF;
    let bestFrom = -1;
    for (let s = 0; s < S.length; s++) {
      while (j < prevPos.length && prevPos[j] <= S[s].pos) {
        if (better(prevCost[j], bestCostVal)) {
          bestCostVal = prevCost[j];
          bestFrom = j;
        }
        j++;
      }
      bestCost[s] = bestCostVal;
      bestFromS[s] = bestFrom;
    }

    const curCost: Cost[] = E.map(() => INF);
    const backS: number[] = E.map(() => -1);
    for (let e = 0; e < E.length; e++) {
      let localBest: Cost = INF;
      let localS = -1;
      for (let s = 0; s < S.length; s++) {
        if (E[e].pos - S[s].pos < opts.minDurMs) break; // S 升序，之后搭配更短
        if (bestFromS[s] < 0) continue;
        const crossCount = cutsBetween(cuts, S[s].pos, E[e].pos);
        const step: Cost = [
          crossCount > 0 ? 1 : 0,
          S[s].dist + E[e].dist,
          S[s].moved || E[e].moved ? 1 : 0,
        ];
        const total = add(bestCost[s], step);
        if (better(total, localBest)) {
          localBest = total;
          localS = s;
        }
      }
      curCost[e] = localBest;
      backS[e] = localS;
    }

    layers.push({ bestFromS, backS, curCost });
    prevPos = E.map((c) => c.pos);
    prevCost = curCost;
  }

  let tail = 0;
  for (let e = 1; e < prevCost.length; e++) {
    if (better(prevCost[e], prevCost[tail])) tail = e;
  }
  if (!Number.isFinite(prevCost[tail][0])) return null;

  const sChosen = new Array<number>(n);
  const eChosen = new Array<number>(n);
  eChosen[n - 1] = tail;
  for (let i = n - 1; i >= 0; i--) {
    const layer = layers[i];
    const s = layer.backS[eChosen[i]];
    sChosen[i] = s;
    if (i > 0) eChosen[i - 1] = layer.bestFromS[s];
  }
  return { sChosen, eChosen };
}

/** 未吸附边界的归因（仅在全局可行、该边界保留原位且非命中切点时调用）。 */
function stayReason(
  cue: MergedCue,
  side: 'start' | 'end',
  otherChosenPos: number,
  otherMoved: boolean,
  cuts: number[],
  opts: SnapOptions,
): string {
  const orig = side === 'start' ? cue.start : cue.end;
  // 原区间内部（严格介于开始与结束之间）距该边界最近的切点
  let nearest = Infinity;
  for (const c of cuts) {
    if (c <= cue.start || c >= cue.end) continue;
    if (Math.abs(c - orig) < Math.abs(nearest - orig)) nearest = c;
  }
  if (!Number.isFinite(nearest)) {
    return '区间内侧无切点，吸附不减少跨镜头数，保留原位';
  }
  const dist = Math.abs(nearest - orig);
  if (dist > opts.thresholdMs) {
    return `最近切点 ${formatTimecode(nearest)} 距边界 ${fmtSec(dist)}，超过阈值 ${fmtSec(opts.thresholdMs)}`;
  }
  if (side === 'start' ? nearest >= cue.end : nearest <= cue.start) {
    return '切点已抵达另一端原边界，吸附将使时长非正';
  }
  // 仅吸附该侧（另一端保持原位）是否满足最短时长
  const aloneDur = side === 'start' ? cue.end - nearest : nearest - cue.start;
  if (aloneDur < opts.minDurMs) {
    return `吸附后时长仅 ${fmtSec(aloneDur)}，短于最短时长 ${fmtSec(opts.minDurMs)}`;
  }
  // 单吸可行却未选：只可能是同条另一端也吸附后，二者无法同时满足最短时长
  if (otherMoved) {
    const pairDur = Math.abs(otherChosenPos - nearest);
    if (pairDur < opts.minDurMs) {
      return '该条两端切点无法同时满足最短时长，已优先吸附另一端';
    }
  }
  return '保留原位为全局最优';
}

/** 镜头切点吸附分析：解析后的切点 + 参数 → 逐条吸附方案与统计。 */
export function analyzeSnaps(cues: MergedCue[], cuts: number[], options: SnapOptions): SnapAnalysis {
  const opts = normOptions(options);
  const n = cues.length;
  const bad = preCheck(cues, opts);
  const perCue: CueCandidates[] = cues.map((cue) => ({
    S: boundaryCandidates(cue.start, 'start', cue.end, cuts, opts),
    E: boundaryCandidates(cue.end, 'end', cue.start, cuts, opts),
  }));
  const result = solve(perCue, cuts, opts, bad);
  const ok = result !== null;

  let crossingBefore = 0;
  for (const c of cues) if (cutsBetween(cuts, c.start, c.end) > 0) crossingBefore++;

  const items: SnapItem[] = [];
  let crossingCues = 0;
  let totalShiftMs = 0;
  let changedCues = 0;

  for (let i = 0; i < n; i++) {
    const cue = cues[i];
    const cutsBefore = cutsBetween(cuts, cue.start, cue.end);
    // 不可解或无方案时回退到“保留原位”候选
    const sCand = result ? perCue[i].S[result.sChosen[i]] : stayCandidate(perCue[i].S);
    const eCand = result ? perCue[i].E[result.eChosen[i]] : stayCandidate(perCue[i].E);
    const sPos = sCand.pos;
    const ePos = eCand.pos;

    const cutsAfter = cutsBetween(cuts, sPos, ePos);
    const crossesAfter = cutsAfter > 0;
    if (ok && crossesAfter) crossingCues++;
    const changed = ok && (sPos !== cue.start || ePos !== cue.end);
    if (changed) {
      changedCues++;
      totalShiftMs += Math.abs(sPos - cue.start) + Math.abs(ePos - cue.end);
    }

    const buildBoundary = (
      side: 'start' | 'end',
      orig: number,
      pos: number,
      cand: BoundCandidate,
      otherPos: number,
      otherMoved: boolean,
    ): SnapBoundary => {
      const moved = ok && pos !== orig;
      const hitCut = cand.cut;
      let reason = '';
      if (!ok) {
        reason = bad.get(i) ?? '上游时间约束不可解，全部保持原时间';
      } else if (!moved) {
        if (cand.cut === orig && cand.dist === 0) reason = ''; // 原位即切点
        else reason = stayReason(cue, side, otherPos, otherMoved, cuts, opts);
      }
      return { from: orig, to: pos, dist: Math.abs(pos - orig), hitCut, moved, reason };
    };

    const start = buildBoundary('start', cue.start, sPos, sCand, ePos, eCand.moved);
    const end = buildBoundary('end', cue.end, ePos, eCand, sPos, sCand.moved);

    items.push({
      index: i,
      key: `${cue.groupIndex}@${sPos}-${ePos}`,
      start,
      end,
      cutsBefore,
      cutsAfter,
      crossesAfter,
      changed,
    });
  }

  let reason = '';
  if (!ok) {
    const parts = [...bad.values()];
    reason =
      parts.length > 0
        ? `存在 ${parts.length} 条无法在吸附中修复的上游问题，全部保持原时间：${parts[0]}${parts.length > 1 ? ' 等' : ''}`
        : '在当前最短时长约束下不存在可行吸附方案，全部保持原时间';
  }

  return {
    cutCount: cuts.length,
    ok,
    reason,
    items,
    crossingBefore,
    crossingCues: ok ? crossingCues : crossingBefore,
    totalShiftMs: ok ? totalShiftMs : 0,
    changedCues: ok ? changedCues : 0,
  };
}

/**
 * 按已采纳条目（key 集合）应用吸附：命中条目替换开始/结束时间，文本、
 * 顺序与 groupIndex 不变；未采纳或已失效（不在 items 中）的 key 被忽略；
 * 不可解条目的新时间等于原时间，应用为空操作。吸附只内收，部分采纳也
 * 不会与相邻条目重叠。没有任何生效采纳时返回原数组。
 */
export function applySnaps(
  cues: MergedCue[],
  items: SnapItem[],
  accepted: ReadonlySet<string>,
): MergedCue[] {
  if (accepted.size === 0) return cues;
  const out = cues.map((c) => ({ ...c }));
  let touched = false;
  for (const it of items) {
    if (!accepted.has(it.key) || !it.changed) continue;
    out[it.index] = { ...out[it.index], start: it.start.to, end: it.end.to };
    touched = true;
  }
  return touched ? out : cues;
}
