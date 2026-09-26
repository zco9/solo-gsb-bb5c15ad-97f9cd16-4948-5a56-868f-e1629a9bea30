import { useEffect, useMemo, useRef, useState } from 'react';
import type { MergedCue } from '../lib/merge';
import { formatTimecode } from '../lib/srt';
import {
  analyzeSnaps,
  parseCutList,
  type SnapAnalysis,
  type SnapOptions,
} from '../lib/snap';

const PAGE = 50;

interface SnapPanelProps {
  /** 当前（已采纳消重、断行与阅读节奏后的）字幕 */
  cues: MergedCue[];
  /** 切点列表原始文本（状态由父组件持有，切换页签不丢失） */
  cutText: string;
  onCutText(text: string): void;
  options: SnapOptions;
  onOptions(next: SnapOptions): void;
  /** 已采纳条目的 key 集合 */
  accepted: ReadonlySet<string>;
  onAccept(key: string): void;
  onRestore(key: string): void;
  onAcceptAll(keys: string[]): void;
  onRestoreAll(): void;
}

type RowStatus = 'applied' | 'ready' | 'cross' | 'plain';

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(2)} 秒`;

export function SnapPanel(props: SnapPanelProps) {
  const { cues, cutText, options, accepted } = props;
  const setCutText = props.onCutText;
  const [shown, setShown] = useState(PAGE);
  const fileRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  // 解析与全局 DP 对后续编辑做 250ms 防抖，避免大列表逐键重算；
  // 初始值随首次渲染立即可用（SSR 同样生效）
  const [debounced, setDebounced] = useState(cutText);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(cutText), 250);
    return () => window.clearTimeout(t);
  }, [cutText]);

  const parsed = useMemo(() => parseCutList(debounced), [debounced]);
  const analysis: SnapAnalysis = useMemo(
    () => analyzeSnaps(cues, parsed.cuts, options),
    [cues, parsed.cuts, options],
  );

  // 已采纳集合可能引用旧切点/参数/上游下的条目；统计与操作都以当前条目为准
  const liveKeys = useMemo(() => new Set(analysis.items.map((it) => it.key)), [analysis]);
  const liveAccepted = useMemo(() => {
    const s = new Set<string>();
    accepted.forEach((k) => {
      if (liveKeys.has(k)) s.add(k);
    });
    return s;
  }, [accepted, liveKeys]);

  const readyKeys = analysis.items.filter((it) => it.changed && !liveAccepted.has(it.key)).map((it) => it.key);

  const readFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setCutText(String(reader.result ?? ''));
    reader.readAsText(file);
  };

  const setOpts = (patch: Partial<SnapOptions>) => props.onOptions({ ...options, ...patch });
  const parseNum = (raw: string, fallback: number, lo: number, hi: number) => {
    const v = Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };

  const statusOf = (it: SnapAnalysis['items'][number]): RowStatus => {
    if (liveAccepted.has(it.key)) return 'applied';
    if (it.changed) return 'ready';
    return it.crossesAfter ? 'cross' : 'plain';
  };

  const invalidIssues = parsed.issues.filter((p) => p.kind === 'invalid');
  const dupIssues = parsed.issues.filter((p) => p.kind === 'duplicate');
  const noCuts = cutText.trim().length === 0;

  return (
    <section className="wrap-panel snap-panel">
      {/* 切点输入 */}
      <div className="snap-input">
        <div className="snap-input-head">
          <strong>镜头切点列表</strong>
          <span className="hint">每行一个 HH:MM:SS,mmm（兼容逗号/小数点与 SRT 序号行）；重复切点自动去重</span>
          <span className="spacer" />
          <button type="button" className="btn sm" onClick={() => fileRef.current?.click()}>
            上传切点文件
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={noCuts}
            onClick={() => setCutText('')}
          >
            清空
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.srt,.tsv,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) readFile(f);
              e.target.value = '';
            }}
          />
        </div>
        <div
          className={`snap-drop ${drag ? 'drag' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) readFile(f);
          }}
        >
          <textarea
            className="paste snap-paste"
            placeholder={'粘贴切点，每行一个，例如：\n00:00:03,800\n00:00:09,500\n00:00:16,000'}
            value={cutText}
            spellCheck={false}
            onChange={(e) => setCutText(e.target.value)}
          />
        </div>
        {!noCuts && (
          <div className="snap-parse">
            {invalidIssues.length === 0 && dupIssues.length === 0 ? (
              <span className="tag ok">已解析 {parsed.cuts.length} 个切点</span>
            ) : (
              <>
                <span className="tag ok">有效切点 {parsed.cuts.length} 个</span>
                {invalidIssues.length > 0 && (
                  <span className="tag warn">{invalidIssues.length} 行无法识别</span>
                )}
                {dupIssues.length > 0 && <span className="tag low">{dupIssues.length} 行重复已忽略</span>}
              </>
            )}
            {parsed.cuts.length > 0 && (
              <span className="tag dim">
                {formatTimecode(parsed.cuts[0])} ~ {formatTimecode(parsed.cuts[parsed.cuts.length - 1])}
              </span>
            )}
            {parsed.issues.slice(0, 4).map((p) => (
              <span key={`${p.line}-${p.kind}`} className="snap-issue" title={p.raw}>
                {p.message}
              </span>
            ))}
            {parsed.issues.length > 4 && <span className="snap-issue">…等 {parsed.issues.length} 条</span>}
          </div>
        )}
      </div>

      {/* 参数与批量操作 */}
      <div className="wrap-settings">
        <label>
          吸附阈值（秒）
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={options.thresholdMs / 1000}
            onChange={(e) =>
              setOpts({
                thresholdMs: Math.round(parseNum(e.target.value, options.thresholdMs / 1000, 0, 10) * 1000),
              })
            }
          />
        </label>
        <label>
          最短时长（秒）
          <input
            type="number"
            min={0.1}
            max={30}
            step={0.1}
            value={options.minDurMs / 1000}
            onChange={(e) =>
              setOpts({
                minDurMs: Math.round(parseNum(e.target.value, options.minDurMs / 1000, 0.1, 30) * 1000),
              })
            }
          />
        </label>
        <span className="spacer" />
        <button
          className="btn sm accent"
          disabled={!analysis.ok || readyKeys.length === 0}
          onClick={() => props.onAcceptAll(readyKeys)}
        >
          全部采纳（{readyKeys.length}）
        </button>
        <button className="btn sm" disabled={liveAccepted.size === 0} onClick={props.onRestoreAll}>
          全部恢复
        </button>
      </div>

      <div className="wrap-summary">
        共 {cues.length} 条 · 切点 {analysis.cutCount} 个 · 跨镜头 {analysis.crossingBefore} →{' '}
        {analysis.crossingCues} 条（消除 {analysis.crossingBefore - analysis.crossingCues} 条）· 边界总位移{' '}
        {fmtSec(analysis.totalShiftMs)} · 改动 {analysis.changedCues} 条 · 已采纳 {liveAccepted.size}
        {!analysis.ok && <em> · 不可解：{analysis.reason}</em>}
        <span className="wrap-hint">
          全局动态规划按顺序最小化：跨镜头字幕数 → 边界总位移 → 改动条数；吸附只内收，部分采纳也不会产生新重叠
        </span>
      </div>

      <div className="wrap-list">
        {cues.length === 0 && <div className="empty">当前没有可吸附的合并结果。</div>}
        {cues.length > 0 && noCuts && (
          <div className="empty">请先在上方粘贴或上传每行一个 HH:MM:SS,mmm 的镜头切点列表。</div>
        )}

        {cues.length > 0 && !noCuts && (
          <div className="snap-table-wrap">
            <table className="snap-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>文本</th>
                  <th>原时间</th>
                  <th>新时间</th>
                  <th>切点</th>
                  <th>位移</th>
                  <th>状态 / 未吸附原因</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {analysis.items.slice(0, shown).map((it) => {
                  const c = cues[it.index];
                  const st = statusOf(it);
                  return (
                    <tr key={it.index} className={`snap-row ${st}`}>
                      <td className="mono">#{it.index + 1}</td>
                      <td className="snap-text">
                        <span>{c.text}</span>
                      </td>
                      <td className="mono">
                        {formatTimecode(it.start.from)}
                        <br />→ {formatTimecode(it.end.from)}
                      </td>
                      <td className={`mono ${it.changed ? 'pace-new' : ''}`}>
                        {formatTimecode(it.start.to)}
                        <br />→ {formatTimecode(it.end.to)}
                      </td>
                      <td className="snap-cuts">
                        <BoundaryCell tag="始" b={it.start} />
                        <BoundaryCell tag="末" b={it.end} />
                        <span className="snap-cross">
                          {it.cutsBefore > 0 ? (
                            <span className={`tag ${it.crossesAfter ? 'warn' : 'ok'}`}>
                              跨切点 {it.cutsBefore}→{it.cutsAfter}
                            </span>
                          ) : (
                            <span className="tag dim">不跨镜头</span>
                          )}
                        </span>
                      </td>
                      <td className="mono">
                        {it.changed ? (
                          <>
                            {it.start.dist > 0 && <div>始 −{fmtSec(it.start.dist)}</div>}
                            {it.end.dist > 0 && <div>末 −{fmtSec(it.end.dist)}</div>}
                          </>
                        ) : (
                          <span className="dim-text">—</span>
                        )}
                      </td>
                      <td className="snap-reason">
                        {st === 'applied' ? (
                          <span className="tag ok">已采纳</span>
                        ) : it.changed ? (
                          <span className="tag go">待采纳</span>
                        ) : null}
                        {it.start.reason && <div className="snap-why">始：{it.start.reason}</div>}
                        {it.end.reason && <div className="snap-why">末：{it.end.reason}</div>}
                        {!analysis.ok && !it.start.reason && !it.end.reason && (
                          <span className="tag warn">保持原时间</span>
                        )}
                      </td>
                      <td className="snap-actions">
                        {it.changed &&
                          (liveAccepted.has(it.key) ? (
                            <button className="btn sm" onClick={() => props.onRestore(it.key)}>
                              恢复
                            </button>
                          ) : (
                            <button className="btn sm accent" onClick={() => props.onAccept(it.key)}>
                              采纳
                            </button>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {analysis.items.length > shown && (
          <button className="btn more" onClick={() => setShown((v) => v + PAGE)}>
            显示更多（剩余 {analysis.items.length - shown} 条）
          </button>
        )}
      </div>
    </section>
  );
}

function BoundaryCell(props: { tag: string; b: SnapAnalysis['items'][number]['start'] }) {
  const { tag, b } = props;
  return (
    <div className="snap-bound">
      <span className="snap-bound-tag">{tag}</span>
      {b.hitCut !== null ? (
        <span className="tag ok" title={`命中切点 ${formatTimecode(b.hitCut)}`}>
          {b.moved ? '吸附 ' : '命中 '}
          {formatTimecode(b.hitCut)}
        </span>
      ) : (
        <span className="tag dim">未吸附</span>
      )}
    </div>
  );
}
