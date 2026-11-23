import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api, type Entry } from "./api";
import { AIFilterReview } from "./AIFilterReview";
import { AITagSuggestions } from "./AITagSuggestions";

export function AIBlock({
  entry,
  onTranslationVisible,
  onTagsChanged,
}: {
  entry: Entry;
  onTranslationVisible: (entryId: string | null) => void;
  onTagsChanged: () => Promise<void>;
}) {
  type ManualAction =
    | "summary"
    | "translation"
    | "keywords"
    | "classification"
    | "explain"
    | "rewrite"
    | "custom"
    | "tags"
    | "filter";
  const actionLabels: Record<ManualAction, string> = {
    summary: "生成摘要",
    translation: "翻译全文",
    keywords: "提取关键词",
    classification: "建议分类",
    explain: "解释文章",
    rewrite: "改写草稿",
    custom: "自定义处理",
    tags: "建议标签",
    filter: "建议过滤",
  };
  type ActionPreview = {
    systemPrompt: string;
    prompt: string;
    body: string;
    chars: number;
    provider: string;
    model: string;
    scopeHash: string;
    contextLength: number;
    truncated: boolean;
  };
  const [open, setOpen] = useState(false),
    [summary, setSummary] = useState(""),
    [translation, setTranslation] = useState(""),
    [translationSource, setTranslationSource] = useState(""),
    [translationTruncated, setTranslationTruncated] = useState(false),
    [keywords, setKeywords] = useState(""),
    [classification, setClassification] = useState(""),
    [explanation, setExplanation] = useState(""),
    [rewrite, setRewrite] = useState(""),
    [custom, setCustom] = useState(""),
    [tagsRevision, setTagsRevision] = useState(0),
    [filterRevision, setFilterRevision] = useState(0),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [showOriginal, setShowOriginal] = useState(true),
    [preview, setPreview] = useState<{
      type: ManualAction;
      details: ActionPreview;
    } | null>(null);
  const actionEntryId = useRef(entry.id);
  const cacheGeneration=useRef(0);
  actionEntryId.current = entry.id;
  useEffect(() => {
    onTranslationVisible(open && translation ? entry.id : null);
    return () => onTranslationVisible(null);
  }, [entry.id, open, translation, onTranslationVisible]);
  useEffect(() => {
    setSummary("");
    setTranslation("");
    setTranslationSource("");
    setTranslationTruncated(false);
    setKeywords("");
    setClassification("");
    setExplanation("");
    setRewrite("");
    setCustom("");
    setPreview(null);
    setBusy("");
    setError("");
    setShowOriginal(true);
    setOpen(false);
  }, [entry.id]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    const load = () => {
      const generation = ++cacheGeneration.current;
      for (const [type, setter] of [
        ["summary", setSummary],
        ["translation", setTranslation],
        ["keywords", setKeywords],
        ["classification", setClassification],
        ["explain", setExplanation],
        ["rewrite", setRewrite],
        ["custom", setCustom],
      ] as const) {
        api
          .get<{ content: string; body: string; truncated: boolean } | null>(
            `/api/entries/${entry.id}/ai?type=${type}`,
          )
          .then((result) => {
            if (active && generation === cacheGeneration.current) {
              setter(result?.content || "");
              if (type === "translation") {
                setTranslationSource(result?.body || "");
                setTranslationTruncated(result?.truncated || false);
              }
            }
          })
          .catch(() => {});
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined,
      revision: number | undefined,
      idle = 0;
    let checking = false;
    const check = async () => {
      if (!active || document.hidden || checking) return;
      checking = true;
      try {
        const status = await api.get<{ revision: number; running: boolean }>(
          "/api/ai/results-version",
        );
        if (!active) return;
        if (status.revision !== revision) {
          load();
          idle = 0;
        } else idle++;
        revision = status.revision;
        if (!document.hidden)
          timer = setTimeout(
            check,
            status.running ? 2000 : Math.min(30000, 5000 * Math.max(1,idle)),
          );
      } catch {
        if (active && !document.hidden) {
          if (revision === undefined) load();
          timer = setTimeout(check, 30000);
        }
      } finally {
        checking = false;
      }
    };
    const resume = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        return;
      }
      if (timer) clearTimeout(timer);
      idle = 0;
      load();
      void check();
    };
    void check();
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("rivu-ai-updated", resume);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
      window.removeEventListener("rivu-ai-updated", resume);
    };
  }, [entry.id,entry.full_content,entry.content,entry.description,open]);
  const prepare = async (type: ManualAction) => {
    setBusy("preview");
    setPreview(null);
    setError("");
    try {
      const details = await api.get<ActionPreview>(
        `/api/entries/${entry.id}/ai/preview?type=${type}`,
      );
      if (actionEntryId.current === entry.id) setPreview({ type, details });
    } catch (e) {
      if (actionEntryId.current === entry.id) setError(String(e));
    } finally {
      if (actionEntryId.current === entry.id) setBusy("");
    }
  };
  const run = async () => {
    if (!preview) return;
    const { type, details } = preview;
    setBusy(type);
    setError("");
    try {
      const result = await api.post<{ content: string }>(
        `/api/entries/${entry.id}/ai`,
        {
          type,
          language: "zh-CN",
          scopeHash: details.scopeHash,
        },
      );
      if (actionEntryId.current !== entry.id) return;
      cacheGeneration.current++;
      if (type === "summary") setSummary(result.content);
      else if (type === "translation") {
        setTranslation(result.content);
        setTranslationSource(details.body);
        setTranslationTruncated(details.truncated);
        setShowOriginal(false);
      } else if (type === "keywords") setKeywords(result.content);
      else if (type === "classification") setClassification(result.content);
      else if (type === "explain") setExplanation(result.content);
      else if (type === "rewrite") setRewrite(result.content);
      else if (type === "custom") setCustom(result.content);
      else if (type === "tags") setTagsRevision((value) => value + 1);
      else if (type === "filter") setFilterRevision((value) => value + 1);
      setPreview(null);
    } catch (e) {
      if (actionEntryId.current === entry.id) {
        setError(String(e));
        setPreview(null);
      }
    } finally {
      if (actionEntryId.current === entry.id) setBusy("");
    }
  };
  return (
    <div className="ai-block">
      <button onClick={() => setOpen(!open)}>
        AI 阅读工具{" "}
        <ChevronDown
          size={16}
          style={{ transform: open ? "rotate(180deg)" : undefined }}
        />
      </button>
      {open && (
        <div className="ai-body">
          <div className="ai-actions">
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() => prepare("summary")}
            >
              {summary ? "查看摘要" : "生成摘要"}
            </button>
            <button
              className="secondary"
              disabled={!!busy}
              onClick={() => prepare("translation")}
            >
              翻译全文
            </button>
          </div>
          <div className="ai-actions">
            {(
              [
                "keywords",
                "classification",
                "tags",
                "filter",
                "explain",
                "rewrite",
                "custom",
              ] as const
            ).map((type) => (
              <button
                key={type}
                className="secondary"
                disabled={!!busy}
                onClick={() => prepare(type)}
              >
                {actionLabels[type]}
              </button>
            ))}
          </div>
          {preview && (
            <div className="ai-consent-preview">
              <strong>确认发送范围 · {actionLabels[preview.type]}</strong>
              <p>
                Provider：{preview.details.provider} · 模型：
                {preview.details.model || "未配置"} · 正文{" "}
                {preview.details.chars} 字。预算{" "}
                {preview.details.contextLength || "兼容模式"}；
                {preview.details.truncated
                  ? "正文已截取，只处理下方范围。"
                  : "正文完整。"}
                确认后才会发送以下标题和正文。
              </p>
              <details open>
                <summary>将发送的提示词与文本</summary>
                <strong>处理要求</strong>
                <pre>{preview.details.systemPrompt}</pre>
                <strong>文章内容</strong>
                <pre>{preview.details.prompt}</pre>
              </details>
              <div className="setting-actions">
                <button className="primary" disabled={!!busy} onClick={run}>
                  发送并{actionLabels[preview.type]}
                </button>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() => setPreview(null)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {summary && (
            <div className="ai-result">
              <strong>摘要</strong>
              <p>{summary}</p>
            </div>
          )}
          {keywords && (
            <div className="ai-result">
              <strong>主题关键词</strong>
              <p>{keywords}</p>
            </div>
          )}
          {classification && (
            <div className="ai-result">
              <strong>主题分类建议</strong>
              <p>{classification}</p>
            </div>
          )}
          <AIFilterReview
            entryId={entry.id}
            revision={filterRevision}
            onChanged={onTagsChanged}
          />
          <AITagSuggestions
            entryId={entry.id}
            revision={tagsRevision}
            onChanged={onTagsChanged}
          />
          {explanation && (
            <div className="ai-result">
              <strong>文章解释</strong>
              <p>{explanation}</p>
            </div>
          )}
          {rewrite && (
            <div className="ai-result">
              <strong>改写草稿</strong>
              <p className="muted">请审阅事实与表达。原文已保留。</p>
              <p>{rewrite}</p>
            </div>
          )}
          {custom && (
            <div className="ai-result">
              <strong>自定义处理结果</strong>
              <p>{custom}</p>
            </div>
          )}
          {translation && (
            <div className="ai-result ai-translation">
              {translationTruncated && (
                <p role="status">
                  此译文只覆盖预览中的截取正文。完整原文仍保存在本地。
                </p>
              )}
              <div className="ai-result-heading">
                <strong>翻译</strong>
                <button onClick={() => setShowOriginal(!showOriginal)}>
                  {showOriginal ? "只看译文" : "显示原文"}
                </button>
              </div>
              {showOriginal && (
                <>
                  <strong>原文</strong>
                  <p className="translation-original">{translationSource}</p>
                </>
              )}
              <strong>译文</strong>
              <p>{translation}</p>
            </div>
          )}
          {busy && <p className="muted">正在处理…</p>}
          {error && <p className="ai-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
