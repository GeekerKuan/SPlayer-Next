import { describe, expect, it } from "vitest";
import { createMessageTimeFormatter, startsMessageTimeGroup } from "./messageTime";

describe("localized conversation timestamps", () => {
  it("groups nearby messages and separates five-minute gaps and local midnight", () => {
    const base = new Date(2026, 9, 4, 10, 0).getTime();
    expect(startsMessageTimeGroup(base)).toBe(true);
    expect(startsMessageTimeGroup(base + 299999, base)).toBe(false);
    expect(startsMessageTimeGroup(base + 300000, base)).toBe(true);
    expect(
      startsMessageTimeGroup(
        new Date(2026, 9, 5, 0, 1).getTime(),
        new Date(2026, 9, 4, 23, 59).getTime(),
      ),
    ).toBe(true);
  });
  it("uses app locale for today, yesterday, two days ago and older dates", () => {
    const now = new Date(2026, 9, 4, 12).getTime();
    const format = createMessageTimeFormatter("zh-CN");
    expect(format(new Date(2026, 9, 4, 10, 30).getTime(), now)).toBe("10:30");
    expect(format(new Date(2026, 9, 3, 10, 30).getTime(), now)).toBe("昨天 10:30");
    expect(format(new Date(2026, 9, 2, 10, 30).getTime(), now)).toBe("前天 10:30");
    expect(format(new Date(2026, 8, 1, 10, 30).getTime(), now)).not.toContain("2026");
    expect(format(new Date(2025, 8, 1, 10, 30).getTime(), now)).toContain("2025");
    expect(
      createMessageTimeFormatter("en-US")(new Date(2026, 9, 3, 10, 30).getTime(), now),
    ).toMatch(/yesterday.*10:30/i);
    expect(format(NaN, now)).toBe("");
  });
  it("handles calendar days across daylight-saving boundaries", () => {
    const format = createMessageTimeFormatter("en-US");
    const now = new Date(2026, 2, 9, 0, 15).getTime();
    expect(format(new Date(2026, 2, 8, 23, 50).getTime(), now)).toMatch(/yesterday/i);
  });
});
