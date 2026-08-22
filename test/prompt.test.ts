import { describe, expect, it } from "vitest";
import { isYes } from "../src/prompt.js";

describe("isYes", () => {
  it("returns true for 'y'", () => {
    expect(isYes("y")).toBe(true);
  });

  it("returns true for 'y'/'yes' regardless of case", () => {
    expect(isYes("Y")).toBe(true);
    expect(isYes("yes")).toBe(true);
    expect(isYes("Yes")).toBe(true);
    expect(isYes("YES")).toBe(true);
  });

  it("returns false for empty input, 'n', 'no', and anything else", () => {
    expect(isYes("")).toBe(false);
    expect(isYes("n")).toBe(false);
    expect(isYes("N")).toBe(false);
    expect(isYes("no")).toBe(false);
    expect(isYes("No")).toBe(false);
    expect(isYes("garbage")).toBe(false);
    expect(isYes("yesplease")).toBe(false);
  });
});
