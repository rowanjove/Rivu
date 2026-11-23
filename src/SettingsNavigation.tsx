import { useModalFocus } from "./useModalFocus";
import { useEffect, useState } from "react";

export const settingsGroups = [
  ["general", "常规"],
  ["appearance", "外观"],
  ["reading", "阅读"],
  ["feeds", "订阅"],
  ["ai", "AI"],
  ["data", "数据"],
  ["backup", "备份"],
  ["advanced", "高级"],
  ["about", "关于"],
] as const;

export function SettingsNavigation({
  initialGroup = "general",
}: {
  initialGroup?: string;
}) {
  const [active, setActive] = useState<string>("general");
  useModalFocus(".settings-dialog:not(.archive-modal)", () =>
    document
      .querySelector<HTMLButtonElement>(
        ".settings-dialog:not(.archive-modal) .dialog-heading button",
      )
      ?.click(),
  );
  useEffect(() => {
    if(initialGroup==='general')return;
    const section = document.getElementById(`settings-${initialGroup}`);
    section?.scrollIntoView({ block: "start" });
    section?.focus({ preventScroll: true });
  }, [initialGroup]);
  useEffect(() => {
    const scroll = document.querySelector<HTMLElement>(".settings-scroll");
    if (!scroll) return;
    const update = () => {
      const top = scroll.getBoundingClientRect().top;
      let current: string = "general";
      for (const [id] of settingsGroups) {
        const section = document.getElementById(`settings-${id}`);
        if (section && section.getBoundingClientRect().top <= top + 36)
          current = id;
      }
      if (
        scroll.scrollTop > 0 &&
        scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2
      )
        current = "about";
      setActive(current);
    };
    scroll.addEventListener("scroll", update, { passive: true });
    update();
    return () => scroll.removeEventListener("scroll", update);
  }, []);
  return (
    <nav className="settings-navigation" aria-label="设置分类">
      {settingsGroups.map(([id, label]) => (
        <button
          key={id}
          type="button"
          aria-current={active === id ? "location" : undefined}
          onFocus={(event) =>
            event.currentTarget.scrollIntoView({
              block: "nearest",
              inline: "nearest",
            })
          }
          onClick={() => {
            const section = document.getElementById(`settings-${id}`);
            section?.scrollIntoView({ block: "start" });
            section?.focus({ preventScroll: true });
            setActive(id);
          }}
        >
          {label}
        </button>
      ))}
    </nav>
  );
}
