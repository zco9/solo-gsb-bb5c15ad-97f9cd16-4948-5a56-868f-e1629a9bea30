import { describe, expect, it } from 'vitest';
import type { MergedCue } from '../merge';
import {
  analyzeSnaps,
  applySnaps,
  DEFAULT_SNAP_OPTIONS,
  parseCutList,
  type SnapOptions,
} from '../snap';

function cue(start: number, end: number, text: string, groupIndex: number): MergedCue {
  return { start, end, text, groupIndex };
}

const OPTS: SnapOptions = { thresholdMs: 1000, minDurMs: 500 };

describe('parseCutList 切点解析', () => {
  it('每行一个 HH:MM:SS,mmm，忽略空行并升序去重', () => {
    const { cuts, issues } = parseCutList('00:00:05,000\n\n00:00:02,500\n00:00:05,000\n');
    expect(cuts).toEqual([2500, 5000]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('duplicate');
    expect(issues[0].line).toBe(4);
  });

  it('兼容 SRT 式序号行与小数点，非法行逐行报错', () => {
    const { cuts, issues } = parseCutList('1\n00:00:03.000\nabc\n00:00:04,000');
    expect(cuts).toEqual([3000, 4000]);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('invalid');
    expect(issues[0].line).toBe(3);
  });

  it('空文本不产生切点', () => {
    expect(parseCutList('  \n\n').cuts).toEqual([]);
  });
});

describe('吸附基本行为', () => {
  it('开始边界吸附到内侧切点，消除跨镜头', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const a = analyzeSnaps(cues, [800], OPTS);
    expect(a.ok).toBe(true);
    expect(a.items[0].start.to).toBe(800);
    expect(a.items[0].start.hitCut).toBe(800);
    expect(a.items[0].start.moved).toBe(true);
    expect(a.items[0].end.to).toBe(2000);
    expect(a.items[0].cutsBefore).toBe(1);
    expect(a.items[0].cutsAfter).toBe(0);
    expect(a.crossingCues).toBe(0);
    expect(a.changedCues).toBe(1);
    expect(a.totalShiftMs).toBe(800);
  });

  it('结束边界吸附到内侧切点', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const a = analyzeSnaps(cues, [1500], OPTS);
    expect(a.items[0].end.to).toBe(1500);
    expect(a.items[0].end.moved).toBe(true);
    expect(a.items[0].cutsAfter).toBe(0);
  });

  it('超出阈值的切点不吸附，并给出原因', () => {
    const cues = [cue(0, 5000, '甲', 0)];
    const a = analyzeSnaps(cues, [2600], OPTS); // 距开始 2600、距结束 2400，均超阈值
    expect(a.items[0].start.moved).toBe(false);
    expect(a.items[0].end.moved).toBe(false);
    expect(a.items[0].start.reason).toContain('超过阈值');
    expect(a.items[0].crossesAfter).toBe(true);
  });

  it('切点恰在原边界上：视为命中，不算改动', () => {
    const cues = [cue(1000, 3000, '甲', 0)];
    const a = analyzeSnaps(cues, [1000], OPTS);
    expect(a.items[0].start.moved).toBe(false);
    expect(a.items[0].start.hitCut).toBe(1000);
    expect(a.items[0].start.reason).toBe('');
    expect(a.changedCues).toBe(0);
  });

  it('区间内无切点：保留原位并说明吸附无收益', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const a = analyzeSnaps(cues, [5000], OPTS);
    expect(a.items[0].start.reason).toContain('不减少跨镜头');
    expect(a.items[0].end.reason).toContain('不减少跨镜头');
  });

  it('外侧切点不吸附（不越过原区间）', () => {
    const cues = [cue(1000, 3000, '甲', 0)];
    const a = analyzeSnaps(cues, [500, 3500], OPTS);
    expect(a.items[0].start.moved).toBe(false);
    expect(a.items[0].end.moved).toBe(false);
  });

  it('吸附后短于最小时长：保留原位并给出原因', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const a = analyzeSnaps(cues, [800], { thresholdMs: 1000, minDurMs: 1500 });
    // 开始吸附到 800 后时长仅 1200ms < 1500ms；结束距该切点 1200ms 超阈值
    expect(a.items[0].start.moved).toBe(false);
    expect(a.items[0].start.reason).toContain('最短时长');
    expect(a.items[0].crossesAfter).toBe(true);
  });

  it('两端切点互斥时只吸附一端，另一端给出原因', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    // 切点 900/1100：开始吸到 1100 或结束吸到 900 均可消除跨镜头，
    // 但两端同时吸附（900,1100 反向）时长非正，互斥
    const a = analyzeSnaps(cues, [900, 1100], { thresholdMs: 1200, minDurMs: 500 });
    expect(a.ok).toBe(true);
    const it = a.items[0];
    expect(it.cutsAfter).toBe(0);
    expect(it.start.moved !== it.end.moved).toBe(true);
    const stayed = it.start.moved ? it.end : it.start;
    expect(stayed.reason).toContain('无法同时满足最短时长');
  });
});

describe('全局动态规划与字典序目标', () => {
  it('跨镜头数优先：多切点全消除优于部分消除', () => {
    const cues = [cue(0, 3000, '甲', 0)];
    const a = analyzeSnaps(cues, [800, 2200], OPTS);
    expect(a.items[0].start.to).toBe(800);
    expect(a.items[0].end.to).toBe(2200);
    expect(a.crossingCues).toBe(0);
  });

  it('位移其次：等效时选择位移更小的方案', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const a = analyzeSnaps(cues, [900], { thresholdMs: 1100, minDurMs: 500 });
    // 开始吸附位移 900ms、结束吸附位移 1100ms，均能消除跨镜头 → 选位移小者
    expect(a.crossingCues).toBe(0);
    expect(a.items[0].start.to).toBe(900);
    expect(a.items[0].end.moved).toBe(false);
    expect(a.totalShiftMs).toBe(900);
  });

  it('改动条数第三：同跨镜头同位移时少改动优先', () => {
    // 两条相邻字幕，切点在空隙中间：吸附任意一侧边界都能消除跨镜头
    const cues = [cue(0, 1000, '甲', 0), cue(2000, 3000, '乙', 1)];
    const a = analyzeSnaps(cues, [1500], OPTS);
    expect(a.crossingCues).toBe(0);
    expect(a.changedCues).toBe(0); // 切点在空隙里，本来就没有跨镜头
  });

  it('相邻联动：上一条结束与下一条开始都向同一切点吸附', () => {
    const cues = [cue(0, 1000, '甲', 0), cue(2000, 3000, '乙', 1)];
    const a = analyzeSnaps(cues, [1000, 2000], OPTS);
    // 切点 1000 恰在上一条结束（命中不改动），2000 恰在下一条开始
    expect(a.items[0].end.hitCut).toBe(1000);
    expect(a.items[1].start.hitCut).toBe(2000);
    expect(a.changedCues).toBe(0);
  });

  it('不重叠约束：吸附后相邻字幕仍不重叠', () => {
    const cues = [cue(0, 1000, '甲', 0), cue(1000, 2000, '乙', 1)];
    const a = analyzeSnaps(cues, [600, 1400], OPTS);
    expect(a.ok).toBe(true);
    expect(a.items[1].start.to).toBeGreaterThanOrEqual(a.items[0].end.to);
  });

  it('结果保持原顺序且每条不短于最小时长', () => {
    const cues = [cue(0, 2000, '甲', 0), cue(2500, 4000, '乙', 1), cue(5000, 6000, '丙', 2)];
    const a = analyzeSnaps(cues, [700, 1600, 3200, 5600], OPTS);
    expect(a.ok).toBe(true);
    let prevEnd = -Infinity;
    for (const it of a.items) {
      expect(it.end.to - it.start.to).toBeGreaterThanOrEqual(OPTS.minDurMs);
      expect(it.start.to).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = it.end.to;
    }
  });
});

describe('不可解情形', () => {
  it('原时长已短于最小时长：标记不可解并保持原时间', () => {
    const cues = [cue(0, 300, '甲', 0)];
    const a = analyzeSnaps(cues, [100], OPTS);
    expect(a.ok).toBe(false);
    expect(a.reason).toContain('最短时长');
    expect(a.items[0].start.to).toBe(0);
    expect(a.items[0].end.to).toBe(300);
    expect(a.items[0].start.reason).toContain('最短时长');
    expect(a.changedCues).toBe(0);
  });

  it('上游相邻重叠：标记不可解并指明原因', () => {
    const cues = [cue(0, 2000, '甲', 0), cue(1500, 3000, '乙', 1)];
    const a = analyzeSnaps(cues, [1000], OPTS);
    expect(a.ok).toBe(false);
    expect(a.items[1].start.reason).toContain('重叠');
    expect(a.crossingCues).toBe(a.crossingBefore);
  });

  it('结束不晚于开始：标记上游时间非法', () => {
    const cues = [cue(2000, 1000, '甲', 0)];
    const a = analyzeSnaps(cues, [], OPTS);
    expect(a.ok).toBe(false);
    expect(a.items[0].start.reason).toContain('非法');
  });
});

describe('applySnaps 采纳应用', () => {
  it('采纳后替换时间，文本与 groupIndex 不变', () => {
    const cues = [cue(0, 2000, '甲', 0), cue(5000, 6000, '乙', 1)];
    const a = analyzeSnaps(cues, [800], OPTS);
    const out = applySnaps(cues, a.items, new Set([a.items[0].key]));
    expect(out[0].start).toBe(800);
    expect(out[0].end).toBe(2000);
    expect(out[0].text).toBe('甲');
    expect(out[0].groupIndex).toBe(0);
    expect(out[1]).toEqual(cues[1]);
    expect(cues[0].start).toBe(0); // 不修改原数组
  });

  it('未采纳或 key 失效时保持原样', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const a = analyzeSnaps(cues, [800], OPTS);
    expect(applySnaps(cues, a.items, new Set())).toEqual(cues);
    expect(applySnaps(cues, a.items, new Set(['stale']))).toEqual(cues);
  });

  it('切点变化导致方案不同：旧 key 自动失效', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const before = analyzeSnaps(cues, [800], OPTS);
    const after = analyzeSnaps(cues, [900], OPTS);
    expect(after.items.map((i) => i.key)).not.toContain(before.items[0].key);
    expect(applySnaps(cues, after.items, new Set([before.items[0].key]))).toEqual(cues);
  });

  it('参数变化导致方案不同：旧 key 同样失效', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const a = analyzeSnaps(cues, [800], OPTS);
    const b = analyzeSnaps(cues, [800], { ...OPTS, thresholdMs: 500 });
    expect(a.items[0].key).not.toBe(b.items[0].key);
  });

  it('部分采纳：只应用命中的条目', () => {
    const cues = [cue(0, 2000, '甲', 0), cue(5000, 7000, '乙', 1)];
    const a = analyzeSnaps(cues, [800, 5800], OPTS);
    expect(a.items[0].changed).toBe(true);
    expect(a.items[1].changed).toBe(true);
    const out = applySnaps(cues, a.items, new Set([a.items[1].key]));
    expect(out[0]).toEqual(cues[0]);
    expect(out[1].start).toBe(5800);
  });

  it('不可解时采纳为空操作', () => {
    const cues = [cue(0, 300, '甲', 0)];
    const a = analyzeSnaps(cues, [100], OPTS);
    expect(applySnaps(cues, a.items, new Set([a.items[0].key]))).toEqual(cues);
  });
});

describe('默认参数与边界', () => {
  it('默认参数：阈值 1.5 秒、最短时长 0.8 秒', () => {
    expect(DEFAULT_SNAP_OPTIONS).toEqual({ thresholdMs: 1500, minDurMs: 800 });
  });

  it('非法参数回退默认', () => {
    const cues = [cue(0, 2000, '甲', 0)];
    const a = analyzeSnaps(cues, [800], { thresholdMs: NaN, minDurMs: NaN });
    expect(a.ok).toBe(true);
    expect(a.items[0].start.to).toBe(800); // 默认阈值 1500 内可吸附
  });

  it('空字幕与空切点：不产生吸附', () => {
    expect(analyzeSnaps([], [1000], OPTS).items).toEqual([]);
    const a = analyzeSnaps([cue(0, 2000, '甲', 0)], [], OPTS);
    expect(a.ok).toBe(true);
    expect(a.changedCues).toBe(0);
    expect(a.items[0].start.reason).toContain('不减少跨镜头');
  });

  it('多条吸附互不干扰且全部满足约束', () => {
    const cues = [
      cue(0, 2000, '甲', 0),
      cue(3000, 5000, '乙', 1),
      cue(6000, 8000, '丙', 2),
    ];
    const a = analyzeSnaps(cues, [800, 4200, 6800], OPTS);
    expect(a.ok).toBe(true);
    expect(a.crossingCues).toBe(0);
    expect(a.changedCues).toBe(3);
    expect(a.items.map((i) => i.start.to)).toEqual([800, 3000, 6800]);
    expect(a.items[1].end.to).toBe(4200);
  });
});
