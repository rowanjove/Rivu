import { openExternalLink } from "./external-link";
import { loadNativeImage } from "./native-image";
import { useEffect, useRef, useState } from "react";
import { api, type Entry, type EntryMedia as Media } from "./api";

function MediaImage({
  entryId,
  item,
  cached,
}: {
  entryId: string;
  item: Media;
  cached?: number;
}) {
  const ref = useRef<HTMLImageElement>(null),
    [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let dispose: (() => void) | undefined,
      stopped = false;
    setStatus("loading");
    const observer = new IntersectionObserver(
      (values) => {
        if (stopped) return;
        for (const value of values) {
          if (value.isIntersecting) {
            if (!dispose)
              dispose = loadNativeImage(element, entryId, item.url, {
                cacheOnly: !!cached,
                onStatus: setStatus,
              });
          } else if (dispose) {
            dispose();
            dispose = undefined;
            setStatus("loading");
          }
        }
      },
      { root: element.closest(".reader-content"), rootMargin: "300px" },
    );
    observer.observe(element);
    return () => {
      stopped = true;
      observer.disconnect();
      dispose?.();
    };
  }, [entryId, item.url, cached]);
  return (
    <div className="media-image-frame">
      {status !== "ready" && (
        <div className="media-image-placeholder">
          {status === "error" ? "图片加载失败" : "加载图片…"}
        </div>
      )}
      <img
        ref={ref}
        alt={item.title || "文章图片"}
        style={status !== "ready" ? { opacity: 0 } : undefined}
      />
    </div>
  );
}

export function EntryMedia({
  entry,
  expanded,
}: {
  entry: Entry;
  expanded: boolean;
}) {
  const [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [attempt, setAttempt] = useState(0);
  const [items, setItems] = useState<Media[]>([]),
    [cached, setCached] = useState<Record<string, number>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    generation = useRef(0);
  useEffect(() => {
    let active = true;
    generation.current++;
    setItems([]);
    setCached({});
    setBusy(false);
    setError("");
    setLoadError("");
    setLoading(true);
    void api
      .get<Media[]>(`/api/entries/${entry.id}/media`)
      .then((value) => {
        if (active) setItems(value);
      })
      .catch((cause) => {
        if (active) setLoadError(`媒体信息读取失败：${String(cause)}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [entry.id, entry.full_content, attempt]);
  if (loadError)
    return (
      <p className="article-error" role="alert">
        {loadError}{" "}
        <button
          className="secondary"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重试媒体信息
        </button>
      </p>
    );
  if (loading)
    return (
      <p className="media-status muted" role="status">
        正在检查媒体…
      </p>
    );
  if (!items.length) return null;
  const images = items.filter((item) => item.kind === "image"),
    audio = items.filter((item) => item.kind === "audio"),
    video = items.filter((item) => item.kind === "video");
  const saveImages = async () => {
    const current = generation.current;
    setBusy(true);
    setError("");
    try {
      for (const item of images.slice(0, 20)) {
        const result = await api.post<{ cached: boolean }>(
          "/api/image-cache/cache",
          { entryId: entry.id, url: item.url, explicit: true },
        );
        if (generation.current !== current) return;
        if (result.cached) {
          setCached((old) => ({
            ...old,
            [item.url]: (old[item.url] || 0) + 1,
          }));
        }
      }
    } catch (cause) {
      if (generation.current === current) setError(String(cause));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  };
  return (
    <details className="entry-media" open={expanded}>
      <summary>
        媒体 · 图片 {images.length} · 音频 {audio.length} · 视频 {video.length}
      </summary>
      {images.length > 0 && (
        <>
          <div className="media-gallery">
            {images.map((item) => (
              <figure key={item.url}>
                <MediaImage
                  entryId={entry.id}
                  item={item}
                  cached={cached[item.url]}
                />
                <figcaption>
                  {item.title || entry.title} ·{" "}
                  {item.source === "body"
                    ? "正文"
                    : item.source === "cover"
                      ? "封面"
                      : item.source === "enclosure"
                        ? "订阅附件"
                        : "订阅元数据"}
                </figcaption>
              </figure>
            ))}
          </div>
          <button className="secondary" disabled={busy} onClick={saveImages}>
            {busy ? "正在缓存…" : "将本篇图库缓存到本机"}
          </button>
          <p className="muted">
            普通图片缓存受设置中的容量限制；可在文章上方选择“保存全文和配图”。
          </p>
        </>
      )}
      {[...audio, ...video].map((item) => (
        <div className="media-attachment" key={`${item.kind}:${item.url}`}>
          <strong>
            {item.kind === "audio" ? "音频" : "视频"} ·{" "}
            {item.title || entry.title}
          </strong>
          <span>
            {item.mime || "媒体文件"} ·{" "}
            {item.source === "enclosure" ? "订阅附件" : "订阅元数据"}
          </span>
          <div className="media-attachment-actions">
            <button
              className="secondary"
              onClick={() =>
                void openExternalLink(entry.url || item.url, setError)
              }
            >
              打开来源站 ↗
            </button>
            <button
              className="secondary"
              onClick={() => void openExternalLink(item.url, setError)}
            >
              打开媒体文件 ↗
            </button>
          </div>
        </div>
      ))}
      {error && (
        <p className="article-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
