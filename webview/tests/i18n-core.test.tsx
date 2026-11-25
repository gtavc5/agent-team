import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTranslator,
  getLocale,
  resetLocaleForTests,
  resolveLocale,
  setLocaleOverride,
  setServerLanguage,
} from "../src/i18n";

afterEach(() => {
  resetLocaleForTests();
});

describe("i18n core", () => {
  it("resolves Chinese and English language settings", () => {
    expect(resolveLocale(undefined)).toBe("en");
    expect(resolveLocale("")).toBe("en");
    expect(resolveLocale("English")).toBe("en");
    expect(resolveLocale("en-US")).toBe("en");
    expect(resolveLocale("简体中文")).toBe("zh-CN");
    expect(resolveLocale("中文")).toBe("zh-CN");
    expect(resolveLocale("zh-CN")).toBe("zh-CN");
    expect(resolveLocale("zh")).toBe("zh-CN");
    expect(resolveLocale("Chinese")).toBe("zh-CN");
  });

  it("switches locale reactively when server language or override changes", () => {
    const { t, useT } = createTranslator({
      greeting: { en: "Hello, {name}!", "zh-CN": "你好，{name}！" },
    });

    function Demo() {
      const tr = useT();
      return <div data-testid="msg">{tr("greeting", { name: "YAAT" })}</div>;
    }

    render(<Demo />);
    expect(getLocale()).toBe("en");
    expect(screen.getByTestId("msg").textContent).toBe("Hello, YAAT!");

    act(() => {
      setServerLanguage("简体中文");
    });
    expect(getLocale()).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(screen.getByTestId("msg").textContent).toBe("你好，YAAT！");
    expect(t("greeting", { name: "Team" })).toBe("你好，Team！");

    act(() => {
      setLocaleOverride("en");
    });
    expect(getLocale()).toBe("en");
    expect(screen.getByTestId("msg").textContent).toBe("Hello, YAAT!");

    act(() => {
      setLocaleOverride(null);
    });
    expect(getLocale()).toBe("zh-CN");
    expect(screen.getByTestId("msg").textContent).toBe("你好，YAAT！");
  });
});
