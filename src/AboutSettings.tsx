import { useEffect, useRef, useState } from "react";
import packageJson from "../package.json";
import type { RuntimeDiagnostics } from "./api";

export function AboutSettings() {
  const [info, setInfo] = useState<RuntimeDiagnostics | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let active = true;
    void window.rivu
      .diagnostics?.()
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      });
    return () => {
      active = false;
    };
  }, []);
  const text = info
    ? `Rivu ${info.build.version}\nBuild ${info.build.buildId}\n构建时间 ${info.build.builtAt}\nSchema ${info.schemaVersion}\nElectron ${info.runtime.electron} · Chromium ${info.runtime.chrome}\nNode ${info.runtime.node} · 内置 Undici ${info.runtime.undici}\n应用 fetch ${info.fetchImplementation}\nSource ${info.build.sourceHash}`
    : "";
  return (
    <>
      <h3>关于 Rivu</h3>
      <p className="muted">版本 {packageJson.version} · Apache License 2.0</p>
      <p className="muted">
        订阅、文章和阅读状态以本机资料库为准。无需账户；AI 为可选功能。
      </p>
      {info && (
        <>
          <label className="build-diagnostics">
            构建诊断信息
            <textarea
              ref={textRef}
              aria-label="构建诊断信息"
              readOnly
              value={text}
              rows={7}
            />
          </label>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setNotice("构建信息已复制");
              } catch {
                textRef.current?.select();
                setNotice("已选中构建信息，可按 Ctrl+C 复制");
              }
            }}
          >
            复制构建信息
          </button>
        </>
      )}
      {error && (
        <p className="article-error" role="alert">
          构建信息读取失败：{error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </>
  );
}
