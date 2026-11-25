import { useCallback, useSyncExternalStore } from "react";

export type Locale = "en" | "zh-CN";

export interface MessageEntry {
  readonly en: string;
  readonly "zh-CN": string;
}

export type MessageCatalog = Record<string, MessageEntry>;

export type MessageParams = Record<string, string | number>;

const STORAGE_KEY = "yaat.locale";
const ZH_PATTERN = /(?:^zh\b|中文|简体|繁體|繁体|汉语|漢語|chinese)/i;

let serverLanguage: string | undefined;
let overrideLocale: Locale | null = readStoredOverride();
let currentLocale: Locale = computeLocale();

const listeners = new Set<() => void>();

function readStoredOverride(): Locale | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "en" || raw === "zh-CN") return raw;
  } catch {
    // Storage may be unavailable in restricted contexts.
  }
  return null;
}

export function resolveLocale(language?: string | null): Locale {
  if (!language) return "en";
  return ZH_PATTERN.test(language.trim()) ? "zh-CN" : "en";
}

function computeLocale(): Locale {
  if (overrideLocale) return overrideLocale;
  if (serverLanguage) return resolveLocale(serverLanguage);
  return "en";
}

function syncDocumentLang(locale: Locale): void {
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.lang = locale;
  }
}

function updateCurrentLocale(): void {
  const next = computeLocale();
  syncDocumentLang(next);
  if (next === currentLocale) return;
  currentLocale = next;
  for (const listener of listeners) {
    listener();
  }
}

export function getLocale(): Locale {
  return currentLocale;
}

export function isZh(): boolean {
  return currentLocale === "zh-CN";
}

export function setServerLanguage(language?: string | null): void {
  const normalized = language?.trim() || undefined;
  if (normalized === serverLanguage) {
    syncDocumentLang(currentLocale);
    return;
  }
  serverLanguage = normalized;
  updateCurrentLocale();
}

export function setLocaleOverride(locale: Locale | null): void {
  overrideLocale = locale;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      if (locale) {
        window.localStorage.setItem(STORAGE_KEY, locale);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
  } catch {
    // Ignore storage errors.
  }
  updateCurrentLocale();
}

export function resetLocaleForTests(): void {
  serverLanguage = undefined;
  overrideLocale = null;
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage errors.
  }
  updateCurrentLocale();
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

export function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = params[key];
    return value === undefined ? match : String(value);
  });
}

export interface Translator<T extends MessageCatalog> {
  readonly t: <K extends keyof T & string>(
    key: K,
    params?: MessageParams,
    locale?: Locale,
  ) => string;
  readonly useT: () => <K extends keyof T & string>(key: K, params?: MessageParams) => string;
}

export function createTranslator<T extends MessageCatalog>(catalog: T): Translator<T> {
  function translate<K extends keyof T & string>(
    key: K,
    params?: MessageParams,
    locale: Locale = currentLocale,
  ): string {
    const entry = catalog[key];
    return interpolate(entry[locale], params);
  }

  function useT(): <K extends keyof T & string>(key: K, params?: MessageParams) => string {
    const locale = useLocale();
    return useCallback(
      <K extends keyof T & string>(key: K, params?: MessageParams) =>
        translate(key, params, locale),
      [locale],
    );
  }

  return { t: translate, useT };
}
