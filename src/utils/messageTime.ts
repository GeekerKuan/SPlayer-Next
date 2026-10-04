/** 按本地日历日和五分钟空档分组，不受夏令时一天长度影响。 */
export function startsMessageTimeGroup(time: number, previous?: number): boolean {
  if (previous === undefined || time - previous >= 5 * 60_000) return true;
  return new Date(time).toDateString() !== new Date(previous).toDateString();
}

/**
 * 复用原生 Intl 和应用语言，格式器按语言创建，避免为每条消息重新构造。
 * @param locale - 应用当前语言
 * @returns 使用本地时区的日期时间格式化函数
 */
export function createMessageTimeFormatter(locale: string): (time: number, now?: number) => string {
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const date = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" });
  const fullDate = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  return (time, now = Date.now()) => {
    const value = new Date(time);
    const today = new Date(now);
    if (!Number.isFinite(value.getTime())) return "";
    const day = (input: Date) => Date.UTC(input.getFullYear(), input.getMonth(), input.getDate());
    const distance = (day(value) - day(today)) / 86_400_000;
    const prefix =
      distance === 0
        ? ""
        : distance === -1 || distance === -2
          ? relative.format(distance, "day")
          : value.getFullYear() === today.getFullYear()
            ? date.format(value)
            : fullDate.format(value);
    return prefix ? `${prefix} ${clock.format(value)}` : clock.format(value);
  };
}
