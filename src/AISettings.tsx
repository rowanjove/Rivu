import { useEffect, useRef, useState } from "react";
import { api } from "./api";

type AIConfig = {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  contextLength: number;
  summaryModel?: string;
  translationModel?: string;
  askModel?: string;
  tagModel?: string;
  customPrompt?: string;
  filterCriteria?: string;
  apiKeyConfigured?: boolean;
};
export function AISettings() {
  const [config, setConfig] = useState<AIConfig>({
      baseUrl: "",
      model: "",
      temperature: 0.3,
      maxTokens: 1200,
      contextLength: 0,
    }),
    [key, setKey] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const saved = useRef<AIConfig | null>(null),
    busyRef = useRef(false),
    generation = useRef(0),
    failedPatch = useRef<Record<string, unknown> | null>(null);
  const reload = async () => {
    const attempt = ++generation.current;
    busyRef.current = true;
    setBusy(true);
    setLoaded(false);
    try {
      const result = await api.get<AIConfig>("/api/ai/settings");
      if (attempt !== generation.current) return;
      saved.current = result;
      const { apiKey, ...fields } = failedPatch.current || {},
        notice = failedPatch.current
          ? "已重新加载保存值；未确认的修改保留为草稿"
          : "已重新加载保存值";
      setConfig({ ...result, ...fields });
      setKey(typeof apiKey === "string" ? apiKey : "");
      failedPatch.current = null;
      setLoaded(true);
      setMessage(notice);
      window.dispatchEvent(new Event('rivu-ai-updated'));
    } catch (error) {
      if (attempt === generation.current) setMessage(String(error));
    } finally {
      if (attempt === generation.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, []);
  const draft = () => ({
    baseUrl: config.baseUrl,
    model: config.model,
    summaryModel: config.summaryModel || "",
    translationModel: config.translationModel || "",
    askModel: config.askModel || "",
    tagModel: config.tagModel || "",
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    contextLength: config.contextLength,
    customPrompt: config.customPrompt || "",
    filterCriteria: config.filterCriteria || "",
    ...(key ? { apiKey: key } : {}),
  });
  const changed = () =>
    Object.fromEntries(
      Object.entries(draft()).filter(
        ([field, value]) =>
          field === "apiKey" ||
          (value !==
            (saved.current as unknown as Record<string, unknown> | null)?.[
              field
            ] &&
            (value !== "" ||
              (saved.current as unknown as Record<string, unknown> | null)?.[
                field
              ] !== undefined)),
      ),
    );
  const persist = async (patch: Record<string, unknown>) => {
    const result = await api.patch<AIConfig>("/api/ai/settings", patch);
    saved.current = result;
    setConfig(result);
    setKey("");
    failedPatch.current = null;
    window.dispatchEvent(new Event("rivu-ai-updated"));
  };
  const save = async () => {
    if (!loaded || busyRef.current) return;
    const patch = changed();
    busyRef.current = true;
    setBusy(true);
    try {
      await persist(patch);
      setMessage("已保存");
    } catch (e) {
      failedPatch.current = patch;
      setLoaded(false);
      setMessage(`保存结果未确认，请先重新加载：${String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const test = async () => {
    if (!loaded || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await api.post<{ model: string; latencyMs: number }>(
        "/api/ai/test",
        draft(),
      );
      setMessage(
        `连接成功（尚未保存）· ${result.model} · ${result.latencyMs} ms`,
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const clearKey = async () => {
    if (!loaded || busyRef.current) return;
    if (
      !confirm("清除本机已保存的 AI Key？已授权的 AI 自动规则将需要重新授权。")
    )
      return;
    const { apiKey, ...pending } = changed();
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await api.patch<AIConfig>("/api/ai/settings", {
        apiKey: "",
      });
      saved.current = result;
      setConfig({ ...result, ...pending });
      window.dispatchEvent(new Event('rivu-ai-updated'));
      setKey("");
      setMessage("已清除本机 AI Key；AI 自动规则需重新授权");
    } catch (e) {
      failedPatch.current = { ...pending, apiKey: "" };
      setLoaded(false);
      setMessage(`清除结果未确认，请先重新加载：${String(e)}`);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <section>
      <h3>AI Provider</h3>
      <p className="muted">
        填写服务地址与默认模型即可开始。本机模型通常无需密钥；测试连接后可保存配置。
      </p>
      {!loaded && (
        <p role="alert">
          AI
          保存配置状态未知，修改与测试已暂停。修复本地设置文件后可只读重新加载。
        </p>
      )}
      <fieldset
        disabled={!loaded || busy}
        style={{ border: 0, padding: 0, margin: 0 }}
      >
        <div className="ai-config">
          <label>
            API Base URL{" "}
            <input
              value={config.baseUrl}
              onChange={(e) =>
                setConfig({ ...config, baseUrl: e.target.value })
              }
              placeholder="http://127.0.0.1:1234/v1"
            />
          </label>
          <label>
            API Key{" "}
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={
                config.apiKeyConfigured
                  ? "已设置，留空保持不变"
                  : "本地模型可留空"
              }
            />
          </label>
          <label>
            默认模型{" "}
            <input
              value={config.model}
              onChange={(e) => setConfig({ ...config, model: e.target.value })}
              placeholder="例如 qwen3.5-9b"
            />
          </label>
        </div>
      </fieldset>
      <div className="setting-actions">
        <button className="secondary" disabled={!loaded || busy} onClick={save}>
          保存配置
        </button>
        <button className="secondary" disabled={!loaded || busy} onClick={test}>
          测试连接
        </button>
        {config.apiKeyConfigured && (
          <button
            className="secondary danger"
            disabled={!loaded || busy}
            onClick={clearKey}
          >
            清除已保存的 AI Key
          </button>
        )}
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void reload()}
        >
          重新加载 AI 配置
        </button>
        <button
          className="secondary"
          disabled={!loaded || busy}
          onClick={() => {
            if (saved.current) {
              setConfig({ ...saved.current });
              setKey("");
              setMessage("已撤销草稿");
            }
          }}
        >
          撤销 AI 草稿
        </button>
        <span className="setting-message" role="status">
          {message}
        </span>
      </div>
      <details className="ai-advanced">
        <summary>模型分工与高级设置</summary>
        <p className="setting-help">
          未填写的分工模型沿用默认模型。仅在需要时调整；折叠不会清除已保存的值。
        </p>
        <fieldset
          disabled={!loaded || busy}
          style={{ border: 0, padding: 0, margin: 0 }}
        >
          <div className="ai-config">
            <label>
              摘要模型{" "}
              <input
                value={config.summaryModel || ""}
                onChange={(e) =>
                  setConfig({ ...config, summaryModel: e.target.value })
                }
                placeholder="留空使用默认模型"
              />
            </label>
            <label>
              翻译模型{" "}
              <input
                value={config.translationModel || ""}
                onChange={(e) =>
                  setConfig({ ...config, translationModel: e.target.value })
                }
                placeholder="留空使用默认模型"
              />
            </label>
            <label>
              问答模型{" "}
              <input
                value={config.askModel || ""}
                onChange={(e) =>
                  setConfig({ ...config, askModel: e.target.value })
                }
                placeholder="留空使用默认模型"
              />
            </label>
            <label>
              标签、关键词与分类模型{" "}
              <input
                value={config.tagModel || ""}
                onChange={(e) =>
                  setConfig({ ...config, tagModel: e.target.value })
                }
                placeholder="留空沿用问答模型或默认模型"
              />
            </label>
            <label>
              Temperature（回答随机性）{" "}
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                aria-label="Temperature"
                value={config.temperature}
                onChange={(e) =>
                  setConfig({ ...config, temperature: Number(e.target.value) })
                }
              />
            </label>
            <label>
              Max Tokens（最长输出）{" "}
              <input
                type="number"
                min="1"
                max="32000"
                aria-label="Max Tokens"
                value={config.maxTokens}
                onChange={(e) =>
                  setConfig({ ...config, maxTokens: Number(e.target.value) })
                }
              />
            </label>
            <label className="ai-context-setting">
              AI 内容过滤条件
              <textarea
                aria-label="AI 内容过滤条件"
                maxLength={1000}
                rows={3}
                value={config.filterCriteria || ""}
                onChange={(event) =>
                  setConfig({ ...config, filterCriteria: event.target.value })
                }
                placeholder="例如：保留有研究证据的航天内容，对广告建议静音。"
              />
            </label>
            <label className="ai-context-setting">
              自定义处理提示词
              <textarea
                aria-label="自定义处理提示词"
                maxLength={4000}
                rows={4}
                value={config.customPrompt || ""}
                onChange={(event) =>
                  setConfig({ ...config, customPrompt: event.target.value })
                }
                placeholder="例如：整理为问题、证据与待核实事项。"
              />
            </label>
            <label className="ai-context-setting">
              Context Length（Token 预算）{" "}
              <input
                aria-label="Context Length（Token 预算）"
                type="number"
                min="0"
                max="262144"
                step="1"
                value={config.contextLength}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    contextLength: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
        </fieldset>
        <p className="setting-message">
          0 沿用旧限制；启用时按 UTF-8 字节数保守估算输入，预留 Max Tokens
          输出空间。不是 Provider 分词计数。修改后需重新预览并授权 AI 规则。
        </p>
      </details>
    </section>
  );
}
