import { observeArticleImages } from "./article-images";
import { openExternalLink, externalUrl } from "./external-link";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { renderArticleFragment } from "./article-html";
import { startArticleLayout } from "./article-layout-session";
import { api, type Entry, type OfflineStatus } from "./api";
import type { ReadingPreferences } from "./reading";

export function RichArticle({
  entry,
  onUpdated,
  linkTarget,
}: {
  entry: Entry;
  onUpdated: (entry: Entry, savedByOffline?: boolean) => void;
  linkTarget: ReadingPreferences["linkTarget"];
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [offline, setOffline] = useState<OfflineStatus | null>(null);
  const [archiveOptions, setArchiveOptions] = useState({
      images: false,
      attachments: false,
      snapshot: false,
    }),
    [archiveNotice, setArchiveNotice] = useState("");
  const [offlineError, setOfflineError] = useState(""),
    [offlineLoading, setOfflineLoading] = useState(true),
    [offlineAttempt, setOfflineAttempt] = useState(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const accessibilityEnabled = useRef(
    window.rivu?.accessibilitySupportEnabled?.() ?? true,
  );
  const layoutRef = useRef<ReturnType<typeof startArticleLayout>>(null);
  useEffect(
    () =>
      window.rivu?.onAccessibilitySupportChanged?.((enabled) => {
        accessibilityEnabled.current = enabled;
        if (enabled) layoutRef.current?.reveal();
      }),
    [],
  );
  const actionScope = useRef<object | null>(null);
  useLayoutEffect(() => {
    const scope = {};
    actionScope.current = scope;
    setBusy(false);
    setError("");
    setArchiveNotice("");
    setOffline(null);
    setOfflineError("");
    setOfflineLoading(true);
    return () => {
      if (actionScope.current === scope) actionScope.current = null;
    };
  }, [entry.id]);
  const article = useMemo(() => {
    const source =
      entry.full_content || entry.content || entry.description || "";
    const fragment = renderArticleFragment(source, {
      kind: "reader",
      baseUrl: entry.url,
    });
    return {
      fragment,
      sourceChars: source.length,
      hasContent: !!fragment?.hasChildNodes(),
    };
  }, [
    entry.id,
    entry.full_content,
    entry.content,
    entry.description,
    entry.url,
  ]);
  useLayoutEffect(() => {
    const root = bodyRef.current,
      fragment = article.fragment;
    if (!root || !fragment) return;
    root.replaceChildren(fragment);
    const layout = startArticleLayout(root, article.sourceChars, {
      accessibilityEnabled: accessibilityEnabled.current,
    });
    layoutRef.current = layout;
    const release = observeArticleImages(root, entry.id);
    return () => {
      if (layoutRef.current === layout) layoutRef.current = null;
      layout?.cancel();
      release();
      while (root.firstChild) fragment.appendChild(root.firstChild);
    };
  }, [article, entry.id]);
  useEffect(() => {
    let active = true;
    setOfflineLoading(true);
    setOfflineError("");
    void api
      .get<OfflineStatus>(`/api/entries/${entry.id}/offline`)
      .then((value) => {
        if (active) setOffline(value);
      })
      .catch((cause) => {
        if (active)
          setOfflineError(`暂时无法确认本地保存状态：${String(cause)}`);
      })
      .finally(() => {
        if (active) setOfflineLoading(false);
      });
    return () => {
      active = false;
    };
  }, [
    entry.id,
    entry.full_content,
    entry.content,
    entry.description,
    offlineAttempt,
  ]);
  const fetchArticle = async () => {
    const scope = actionScope.current;
    setBusy(true);
    setError("");
    try {
      const next = await api.post<Entry>(`/api/entries/${entry.id}/full-text`);
      if (actionScope.current === scope) onUpdated(next);
    } catch (e) {
      if (actionScope.current === scope) setError(String(e));
    } finally {
      if (actionScope.current === scope) setBusy(false);
    }
  };
  const saveOffline = async (includeImages: boolean) => {
    const scope = actionScope.current;
    setBusy(true);
    setError("");
    try {
      const status = await api.post<OfflineStatus>(
        `/api/entries/${entry.id}/offline`,
        { includeImages },
      );
      window.dispatchEvent(new Event("rivu-image-cache-updated"));
      if (actionScope.current !== scope) return;
      setOffline(status);
      const next = await api.get<Entry>(`/api/entries/${entry.id}`);
      if (actionScope.current === scope) onUpdated(next, true);
    } catch (e) {
      if (actionScope.current === scope) setError(String(e));
    } finally {
      if (actionScope.current === scope) setBusy(false);
    }
  };
  const savePermanent = async () => {
    const scope = actionScope.current;
    setBusy(true);
    setError("");
    setArchiveNotice("");
    try {
      const result = await api.post<{
        newVersion: boolean;
        assetsAdded: number;
        errors: string[];
      }>(`/api/entries/${entry.id}/archive`, archiveOptions);
      if (actionScope.current === scope)
        setArchiveNotice(
          `已永久归档${result.newVersion ? "，新增正文版本" : ""}；新增 ${result.assetsAdded} 个资源。${result.errors.length ? `${result.errors.length} 个资源失败，可重试：${result.errors[0]}` : ""}`,
        );
    } catch (e) {
      if (actionScope.current === scope) setError(String(e));
    } finally {
      if (actionScope.current === scope) setBusy(false);
    }
  };
  return (
    <>
      <div className="article-actions">
        {!entry.full_content && !article.hasContent && (
          <button
            className="secondary"
            disabled={busy || !entry.url}
            onClick={fetchArticle}
          >
            获取全文
          </button>
        )}
        <button
          className="secondary"
          disabled={busy || !entry.url}
          onClick={() => saveOffline(true)}
        >
          {busy
            ? "正在处理…"
            : offline?.requestedImages &&
                ["partial", "failed", "interrupted"].includes(offline.status)
              ? "重试离线图片"
              : "保存全文和配图"}
        </button>
        <details className="article-save-options">
          <summary>更多保存选项</summary>
          <div className="article-save-menu">
            <button
              className="secondary"
              disabled={busy || !entry.url}
              onClick={fetchArticle}
            >
              {entry.full_content ? "重新获取全文" : "获取全文"}
            </button>
            <button
              className="secondary"
              disabled={busy || !entry.url}
              onClick={() => saveOffline(false)}
            >
              稍后阅读并保存全文
            </button>
            <div className="archive-actions">
              <button
                className="secondary"
                disabled={busy}
                onClick={savePermanent}
              >
                永久归档当前正文
              </button>
              {(["images", "attachments", "snapshot"] as const).map((key) => (
                <label key={key}>
                  <input
                    type="checkbox"
                    checked={archiveOptions[key]}
                    onChange={(e) =>
                      setArchiveOptions((old) => ({
                        ...old,
                        [key]: e.target.checked,
                      }))
                    }
                  />
                  {key === "images"
                    ? "配图"
                    : key === "attachments"
                      ? "音视频附件"
                      : "来源网页快照"}
                </label>
              ))}
            </div>
          </div>
        </details>
      </div>
      <div className="offline-status" role="status">
        {offline ? (
          <>
            <span>
              {offline.feedBody ? "订阅正文已在本地" : "订阅仅含标题"}
            </span>
            <span>{offline.fullText ? "全文已在本地" : "全文未保存"}</span>
            {offline.images.total > 0 && (
              <span>
                配图已缓存 {offline.images.cached}/{offline.images.total}
              </span>
            )}
          </>
        ) : (
          !offlineError && <span>正在检查本地保存状态…</span>
        )}
        {offlineLoading && offline && <span>正在更新保存状态…</span>}
        {busy && <span>正在处理…</span>}
        {offline?.lastError && (
          <span className="offline-error">{offline.lastError}</span>
        )}
        {archiveNotice && <span>{archiveNotice}</span>}
      </div>
      {offlineError && (
        <p className="article-error" role="alert">
          {offlineError}{" "}
          <button
            className="secondary"
            disabled={offlineLoading}
            onClick={() => setOfflineAttempt((value) => value + 1)}
          >
            重试保存状态
          </button>
        </p>
      )}
      {error && (
        <p className="article-error" role="alert">
          {error}
        </p>
      )}
      {article.hasContent ? (
        <div
          key="rich-body"
          ref={bodyRef}
          className="article-body rich-body"
          onClick={(e) => {
            const a = (e.target as HTMLElement).closest("a");
            if (a) {
              e.preventDefault();
              const href = a.getAttribute("href");
              if (
                href &&
                externalUrl(href) &&
                (linkTarget === "external" ||
                  window.confirm(`在浏览器打开此链接？\n${href}`))
              )
                void openExternalLink(href, setError);
            }
          }}
        />
      ) : (
        <div key="empty-body" className="article-body">
          <p>此订阅只提供了文章标题。可点击下方链接阅读原文。</p>
        </div>
      )}
    </>
  );
}
