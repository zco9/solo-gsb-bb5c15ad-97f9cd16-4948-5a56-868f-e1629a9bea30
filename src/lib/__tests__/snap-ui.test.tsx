import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SnapPanel } from '../../components/SnapPanel';
import type { MergedCue } from '../merge';
import { DEFAULT_SNAP_OPTIONS } from '../snap';

const noop = () => {};

function renderPanel(
  cues: MergedCue[],
  cutText: string,
  accepted: ReadonlySet<string> = new Set(),
) {
  return renderToString(
    <SnapPanel
      cues={cues}
      cutText={cutText}
      onCutText={noop}
      options={DEFAULT_SNAP_OPTIONS}
      onOptions={noop}
      accepted={accepted}
      onAccept={noop}
      onRestore={noop}
      onAcceptAll={noop}
      onRestoreAll={noop}
    />,
  );
}

const cues: MergedCue[] = [
  { start: 0, end: 3000, text: '第一条字幕内容', groupIndex: 0 },
  { start: 5000, end: 8000, text: '第二条字幕内容', groupIndex: 1 },
];

describe('SnapPanel 渲染冒烟', () => {
  it('空状态提示粘贴切点', () => {
    const html = renderPanel(cues, '');
    expect(html).toContain('镜头切点列表');
    expect(html).toContain('HH:MM:SS,mmm');
    expect(html).toContain('请先在上方粘贴或上传');
    expect(html).toContain('上传切点文件');
  });

  it('解析切点并展示原/新时间、命中切点与吸附操作', () => {
    const html = renderPanel(cues, '00:00:00,800\n00:00:07,200\n');
    expect(html).toMatch(/已解析[^]*2[^]*个切点/);
    expect(html).toContain('原时间');
    expect(html).toContain('新时间');
    expect(html).toMatch(/吸附[^]*00:00:00,800/);
    expect(html).toContain('待采纳');
    expect(html).toMatch(/全部采纳（[^]*2[^]*）/);
  });

  it('非法与重复切点逐行提示', () => {
    const html = renderPanel(cues, 'abc\n00:00:00,800\n00:00:00,800\n');
    expect(html).toMatch(/1[^]*行无法识别/);
    expect(html).toMatch(/1[^]*行重复已忽略/);
    expect(html).toContain('第 3 行切点 00:00:00,800 重复，已忽略');
  });

  it('未吸附条目展示原因', () => {
    const html = renderPanel(cues, '00:00:02,600\n'); // 超默认 1.5 秒阈值
    expect(html).toContain('超过阈值');
    expect(html).toContain('未吸附');
  });
});
