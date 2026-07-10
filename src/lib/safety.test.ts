import { describe, expect, it } from "vitest";
import { assessSafetyRisk } from "./safety";

describe("safety risk assessment", () => {
  it("detects urgent, current risk language", () => {
    expect(assessSafetyRisk("我已经准备伤害自己了").level).toBe("urgent");
    expect(assessSafetyRisk("我现在站在楼顶").level).toBe("urgent");
  });

  it("keeps ambiguous risk language at concern", () => {
    expect(assessSafetyRisk("有时候真的不想活").level).toBe("concern");
  });

  it("recognizes explicit negation", () => {
    expect(assessSafetyRisk("我没有自杀的想法或计划").level).toBe("none");
    expect(assessSafetyRisk("我不打算伤害自己").level).toBe("none");
  });
});
