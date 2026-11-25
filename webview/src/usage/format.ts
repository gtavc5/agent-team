import { getLocale, useLocale, type Locale } from "../i18n";
import { tUsage } from "../i18n/usage";

export const tokenParts = ["input", "cacheRead", "cacheWrite", "output"] as const;

function usageFormats(locale: Locale) {
  const count = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 });
  const dateOptions = { month: "short", day: "numeric", timeZone: "UTC" } as const;
  const dateLocale = locale === "en" ? "en-GB" : locale;
  // Use stable GMT offset parts; the catalog controls the displayed date order and separators.
  const recordTime = (timeZone?: string) =>
    new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "en-US", {
      year: "numeric",
      month: locale === "en" ? "short" : "numeric",
      day: locale === "en" ? "2-digit" : "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
      timeZoneName: "longOffset",
    });
  return {
    locale,
    count,
    compact: new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }),
    usd: new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      maximumSignificantDigits: 10,
    }),
    shortDay: new Intl.DateTimeFormat(dateLocale, dateOptions),
    shortHour: new Intl.DateTimeFormat(dateLocale, {
      ...dateOptions,
      hour: "2-digit",
      minute: "2-digit",
    }),
    share: (numerator: number, denominator: number) =>
      denominator > 0
        ? percent.format(numerator / denominator)
        : tUsage("notAvailable", undefined, locale),
    incomplete: (sources: number) =>
      tUsage(
        sources === 1 ? "sourceIncomplete" : "sourcesIncomplete",
        {
          count: count.format(sources),
        },
        locale,
      ),
    browserTime: recordTime(),
    utcTime: recordTime("UTC"),
    recordTime,
  };
}

const formats = { en: usageFormats("en"), "zh-CN": usageFormats("zh-CN") };

export function useUsageFormat() {
  return formats[useLocale()];
}

export function formatRecordTime(date: Date, timeZone?: string, locale: Locale = getLocale()) {
  const { utcTime, browserTime, recordTime } = formats[locale];
  const parts = (format: Intl.DateTimeFormat) =>
    Object.fromEntries(format.formatToParts(date).map(({ type, value }) => [type, value]));
  const u = parts(utcTime);
  const l = parts(timeZone ? recordTime(timeZone) : browserTime);
  const offset =
    l.timeZoneName
      .slice(3)
      .replace(/^([+-])0(\d)/, "$1$2")
      .replace(/:00$/, "") || "+0";
  const sameDate = u.year === l.year && u.month === l.month && u.day === l.day;
  const sameYear = u.year === l.year;
  const utc = tUsage(
    "recordDateTime",
    {
      date: tUsage("recordDate", u, locale),
      time: `${u.hour}:${u.minute} UTC`,
    },
    locale,
  );
  const time = `${l.hour}:${l.minute} UTC${offset}`;
  const local = sameDate
    ? time
    : tUsage(
        "recordDateTime",
        {
          date: tUsage(sameYear ? "recordDateSameYear" : "recordDate", l, locale),
          time,
        },
        locale,
      );
  return { utc, local };
}
