import { useModalFocus } from "./useModalFocus";
import { useRef, useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  api,
  type Category,
  type Feed,
  type JsonMapping,
  type Preview,
  type RsshubInstance,
} from "./api";
import { SourceIcon } from "./SourceIcon";

const emptyMapping: JsonMapping = {
  itemsPath: "items",
  titlePath: "title",
  idPath: "id",
  urlPath: "url",
  datePath: "published_at",
  contentPath: "content",
  summaryPath: "summary",
  authorPath: "author",
  imagePath: "image",
};
const mappingFields: [keyof JsonMapping, string][] = [
  ["itemsPath", "文章数组"],
  ["titlePath", "文章标题"],
  ["idPath", "唯一 ID"],
  ["urlPath", "文章链接"],
  ["datePath", "发布时间"],
  ["contentPath", "正文"],
  ["summaryPath", "摘要"],
  ["authorPath", "作者"],
  ["imagePath", "封面图片"],
];
type JsonPreview = Preview & { skipped: number };

export function AddFeedDialog({
  categories,
  onClose,
  onSubscribed,
  editingFeed,
}: {
  categories: Category[];
  onClose: () => void;
  onSubscribed: () => Promise<void>;
  editingFeed?: Feed;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, onClose);
  const [mode, setMode] = useState<
    "standard" | "rsshub" | "custom_json" | "newsletter"
  >(editingFeed ? "custom_json" : "standard");
  const [url, setUrl] = useState(editingFeed?.url || ""),
    [title, setTitle] = useState(editingFeed?.title || ""),
    [route, setRoute] = useState(""),
    [instanceId, setInstanceId] = useState(""),
    [instances, setInstances] = useState<RsshubInstance[]>([]);
  const [mapping, setMapping] = useState<JsonMapping>(() => {
    try {
      return editingFeed?.json_mapping
        ? { ...emptyMapping, ...JSON.parse(editingFeed.json_mapping) }
        : emptyMapping;
    } catch {
      return emptyMapping;
    }
  });
  const [previews, setPreviews] = useState<Preview[]>([]),
    [selected, setSelected] = useState(0),
    [categoryId, setCategoryId] = useState(""),
    [allowPrivate, setAllowPrivate] = useState(!!editingFeed?.allow_private),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [skipped, setSkipped] = useState(0);
  const [newsletterDraft, setNewsletterDraft] =
    useState<Awaited<ReturnType<typeof window.rivu.previewNewsletter>>>(null);
  const [fetchInterval, setFetchInterval] = useState(30);
  const previewGeneration = useRef(0),
    pendingPreview = useRef<string | null>(null),
    subscribing = useRef(false);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const inputKey = JSON.stringify({
    mode,
    url: url.trim(),
    title: title.trim(),
    instanceId,
    route: route.trim(),
    mapping,
    allowPrivate,
  });
  const currentInput = useRef(inputKey);
  currentInput.current = inputKey;
  useEffect(() => {
    previewGeneration.current++;
    pendingPreview.current = null;
    setPreviewKey(null);
    setPreviews([]);
    if (!subscribing.current) setBusy(false);
    setError("");
  }, [inputKey]);
  useEffect(
    () => () => {
      previewGeneration.current++;
      pendingPreview.current = null;
    },
    [],
  );
  useEffect(() => {
    if (editingFeed) return;
    api
      .get<RsshubInstance[]>("/api/rsshub/instances")
      .then((rows) => {
        setInstances(rows);
        setInstanceId(rows.find((x) => x.enabled)?.id || "");
      })
      .catch((e) => setError(String(e)));
  }, [editingFeed]);
  const changeMode = (value: typeof mode) => {
    setMode(value);
    setPreviews([]);
    setError("");
  };
  const changeMapping = (key: keyof JsonMapping, value: string) => {
    setMapping((previous) => ({ ...previous, [key]: value }));
    setPreviews([]);
  };
  const chooseNewsletter = async () => {
    if (pendingPreview.current || subscribing.current) return;
    const key = inputKey,
      generation = ++previewGeneration.current;
    const current = () =>
      generation === previewGeneration.current && currentInput.current === key;
    pendingPreview.current = key;
    setBusy(true);
    setError("");
    try {
      const draft = await window.rivu.previewNewsletter();
      if (current() && draft) {
        setNewsletterDraft(draft);
        setTitle(
          draft.folder.split(/[\\/]/).filter(Boolean).at(-1) ||
            "本地 Newsletter",
        );
      }
    } catch (e) {
      if (current()) setError(String(e));
    } finally {
      if (current()) {
        pendingPreview.current = null;
        setBusy(false);
      }
    }
  };
  const detect = async () => {
    if (
      subscribing.current ||
      pendingPreview.current === inputKey ||
      mode === "newsletter"
    )
      return;
    const key = inputKey,
      generation = ++previewGeneration.current;
    const current = () =>
      generation === previewGeneration.current && currentInput.current === key;
    pendingPreview.current = key;
    setBusy(true);
    setError("");
    setPreviews([]);
    setPreviewKey(null);
    try {
      let rows: Preview[],
        skipped = 0;
      if (mode === "standard")
        rows = await api.post<Preview[]>("/api/feeds/discover", {
          url: url.trim(),
          allowPrivate,
        });
      else if (mode === "rsshub")
        rows = [
          await api.post<Preview>("/api/rsshub/preview", {
            instanceId,
            route: route.trim(),
          }),
        ];
      else {
        const preview = await api.post<JsonPreview>(
          "/api/feeds/custom-json/preview",
          {
            url: url.trim(),
            title: title.trim(),
            mapping: { ...mapping },
            allowPrivate,
          },
        );
        rows = [preview];
        skipped = preview.skipped;
      }
      if (current()) {
        setPreviews(rows);
        setPreviewKey(key);
        setSkipped(skipped);
        setSelected(0);
      }
    } catch (e) {
      if (current()) setError(String(e));
    } finally {
      if (current()) {
        pendingPreview.current = null;
        setBusy(false);
      }
    }
  };
  const subscribe = async () => {
    if (subscribing.current || pendingPreview.current) return;
    if (
      mode !== "newsletter" &&
      (previewKey !== inputKey || !previews[selected])
    ) {
      setError("输入已变化，请重新预览后订阅。");
      return;
    }
    subscribing.current = true;
    setBusy(true);
    setError("");
    try {
      if (editingFeed)
        await api.patch(`/api/feeds/${editingFeed.id}/json-mapping`, {
          mapping,
        });
      else if (mode === "standard")
        await api.post("/api/feeds", {
          url: previews[selected].url,
          categoryId: categoryId || undefined,
          allowPrivate,
          fetchInterval,
        });
      else if (mode === "rsshub")
        await api.post("/api/rsshub/subscribe", {
          instanceId,
          route: route.trim(),
          categoryId: categoryId || undefined,
          fetchInterval,
        });
      else if (mode === "newsletter") {
        if (!newsletterDraft) throw Error("请先选择 Newsletter 文件夹");
        const feed = await window.rivu.subscribeNewsletter(
          newsletterDraft.id,
          title.trim(),
          categoryId || undefined,
        );
        await api.post(`/api/feeds/${feed.id}/refresh`).catch(() => {});
      } else
        await api.post("/api/feeds/custom-json", {
          url: url.trim(),
          title: title.trim(),
          mapping,
          categoryId: categoryId || undefined,
          allowPrivate,
          fetchInterval,
        });
      await onSubscribed();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      subscribing.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      className="overlay"
      style={editingFeed ? { zIndex: 6 } : undefined}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-feed-title"
        tabIndex={-1}
      >
        <div className="dialog-heading">
          <h2 id="add-feed-title">
            {editingFeed ? "编辑 JSON 字段映射" : "添加订阅"}
          </h2>
          <button
            className="icon-button"
            aria-label="关闭窗口"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>
        {!editingFeed && (
          <div className="source-tabs">
            <button
              className={mode === "standard" ? "active" : ""}
              onClick={() => changeMode("standard")}
            >
              RSS / 网站
            </button>
            <button
              className={mode === "rsshub" ? "active" : ""}
              onClick={() => changeMode("rsshub")}
            >
              RSSHub
            </button>
            <button
              className={mode === "custom_json" ? "active" : ""}
              onClick={() => changeMode("custom_json")}
            >
              JSON API
            </button>
            <button
              className={mode === "newsletter" ? "active" : ""}
              onClick={() => changeMode("newsletter")}
            >
              Newsletter
            </button>
          </div>
        )}
        {mode === "standard" ? (
          <>
            <p>
              输入 RSS、Atom、JSON Feed 或网站地址；GitHub
              项目页可发现发布与提交，YouTube 频道地址可发现视频订阅。
            </p>
            <div className="input-row">
              <input
                autoFocus
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setPreviews([]);
                }}
                onKeyDown={(e) => e.key === "Enter" && void detect()}
                placeholder="https://example.com"
              />
              <button
                className="primary"
                disabled={busy || !url.trim()}
                onClick={detect}
              >
                {busy ? "检测中…" : "检测"}
              </button>
            </div>
            <label className="local-network-option">
              <input
                type="checkbox"
                checked={allowPrivate}
                onChange={(e) => {
                  setAllowPrivate(e.target.checked);
                  setPreviews([]);
                }}
              />
              允许此订阅访问 localhost 或内网 IP（仅可信来源）
            </label>
            {error && (
              <p className="dialog-error">
                {error}{" "}
                <button onClick={() => changeMode("rsshub")}>
                  尝试 RSSHub
                </button>
              </p>
            )}
          </>
        ) : mode === "rsshub" ? (
          <>
            <p>
              RSSHub 需要站点对应的路由。选择实例并填写路由后可先预览，再订阅。
            </p>
            <div className="hub-fields">
              <select
                value={instanceId}
                onChange={(e) => setInstanceId(e.target.value)}
              >
                <option value="">选择实例</option>
                {instances
                  .filter((x) => x.enabled)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name} · {x.base_url}
                    </option>
                  ))}
              </select>
              <div className="input-row">
                <input
                  value={route}
                  onChange={(e) => setRoute(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void detect()}
                  placeholder="/github/repos/owner/repo"
                />
                <button
                  className="primary"
                  disabled={busy || !instanceId || !route.trim()}
                  onClick={detect}
                >
                  {busy ? "预览中…" : "预览"}
                </button>
              </div>
            </div>
            {error && <p className="dialog-error">{error}</p>}
          </>
        ) : mode === "newsletter" ? (
          <>
            <p>
              选择存放 <code>.eml</code> 邮件的本地文件夹。Rivu
              会按刷新计划读取新增邮件，无需邮箱账号；正文中的远程图片和附件不会导入。
            </p>
            <button
              className="secondary"
              disabled={busy}
              onClick={chooseNewsletter}
            >
              {newsletterDraft ? "重新选择文件夹" : "选择文件夹"}
            </button>
            {newsletterDraft && (
              <>
                <div className="feed-preview">
                  <h3>{newsletterDraft.folder}</h3>
                  <p>
                    发现 {newsletterDraft.count} 封 .eml 邮件
                    {newsletterDraft.skipped
                      ? `；预览跳过 ${newsletterDraft.skipped} 封`
                      : ""}
                  </p>
                  <ul>
                    {newsletterDraft.samples.map((item) => (
                      <li key={item.file}>
                        {item.title} · {item.sender || "未知发件人"}
                      </li>
                    ))}
                  </ul>
                </div>
                <label className="newsletter-name">
                  订阅名称
                  <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                </label>
                <select
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">不分类</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <div className="dialog-actions">
                  <button
                    className="primary"
                    disabled={busy || !title.trim()}
                    onClick={subscribe}
                  >
                    订阅此文件夹
                  </button>
                </div>
              </>
            )}
            {error && (
              <p className="dialog-error" role="alert">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <p>
              连接返回文章数组的公开 JSON 接口。字段路径用点号分隔，如{" "}
              <code>data.articles</code>；根数组填 <code>$</code>
              。文章字段路径相对于每篇文章填写。仅支持
              GET，无账号或自定义请求头。
            </p>
            <div className="json-api-fields">
              <label>
                来源名称
                <input
                  value={title}
                  disabled={!!editingFeed}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    setPreviews([]);
                  }}
                  placeholder="我的 JSON 来源"
                />
              </label>
              <label>
                接口地址
                <input
                  value={url}
                  disabled={!!editingFeed}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    setPreviews([]);
                  }}
                  placeholder="https://example.com/api/articles"
                />
              </label>
              {mappingFields.map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    value={mapping[key]}
                    onChange={(e) => changeMapping(key, e.target.value)}
                    placeholder={
                      key === "itemsPath" ? "data.articles" : "可留空"
                    }
                  />
                </label>
              ))}
            </div>
            <p className="setting-help">
              文章数组、标题必填；唯一 ID
              与文章链接至少填写一项。接口地址、字段映射随本地数据库备份；请勿在地址中填写密钥。
            </p>
            {!editingFeed && (
              <label className="local-network-option">
                <input
                  type="checkbox"
                  checked={allowPrivate}
                  onChange={(e) => {
                    setAllowPrivate(e.target.checked);
                    setPreviews([]);
                  }}
                />
                允许此订阅访问 localhost 或内网 IP（仅可信来源）
              </label>
            )}
            <div className="dialog-actions">
              <button
                className="secondary"
                disabled={busy || !url.trim() || !title.trim()}
                onClick={detect}
              >
                {busy ? "预览中…" : "预览映射"}
              </button>
            </div>
            {error && <p className="dialog-error">{error}</p>}
          </>
        )}
        {previews.length > 0 && previewKey === inputKey && (
          <>
            <div className="preview-picker">
              {previews.map((p, i) => (
                <button
                  key={p.url}
                  className={selected === i ? "active" : ""}
                  onClick={() => setSelected(i)}
                >
                  {p.title}
                </button>
              ))}
            </div>
            <div className="feed-preview">
              <div className="feed-preview-heading">
                <SourceIcon
                  icon={previews[selected].icon}
                  title={previews[selected].title}
                />
                <h3>{previews[selected].title}</h3>
              </div>
              {previews[selected].description && (
                <p>{previews[selected].description}</p>
              )}
              <p className="feed-preview-address">
                订阅源：{previews[selected].url}
              </p>
              {previews[selected].siteUrl && (
                <p className="feed-preview-address">
                  网站：{previews[selected].siteUrl}
                </p>
              )}
              {!editingFeed && (
                <label className="feed-preview-frequency">
                  刷新频率
                  <select
                    aria-label="刷新频率"
                    value={fetchInterval}
                    onChange={(e) => setFetchInterval(Number(e.target.value))}
                  >
                    {[0, 15, 30, 60, 180, 360, 720].map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes ? `${minutes} 分钟` : "手动"}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {mode === "custom_json" && (
                <p>
                  提取 {previews[selected].items.length} 篇，跳过 {skipped} 篇
                </p>
              )}
              <ul>
                {previews[selected].items.slice(0, 5).map((item, i) => (
                  <li key={i}>{item.title}</li>
                ))}
              </ul>
            </div>
            {!editingFeed && (
              <label className="feed-preview-category">
                分类
                <select
                  aria-label="订阅分类"
                  value={categoryId}
                  onChange={(e) => setCategoryId(e.target.value)}
                >
                  <option value="">不分类</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="dialog-actions">
              <button className="primary" disabled={busy} onClick={subscribe}>
                {editingFeed ? "保存映射" : "订阅"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
