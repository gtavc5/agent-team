const ZH_LANGUAGE_PATTERN = /(?:^zh\b|中文|简体|繁體|繁体|汉语|漢語|chinese)/i;

export function isChineseLanguage(language?: string | null): boolean {
  return !!language && ZH_LANGUAGE_PATTERN.test(language.trim());
}

export function pickText(language: string | null | undefined, en: string, zh: string): string {
  return isChineseLanguage(language) ? zh : en;
}
