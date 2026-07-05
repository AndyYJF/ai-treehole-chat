import { z } from "zod";

export const modelTierSchema = z.enum(["auto", "light", "balanced", "deep"]);

export type ModelTier = z.infer<typeof modelTierSchema>;

export type RoutedModel = {
  tier: Exclude<ModelTier, "auto">;
  label: string;
  model: "deepseek-v4-flash" | "deepseek-v4-pro";
  reason: string;
};

const deepTalkSignals = [
  "怎么办",
  "为什么",
  "复盘",
  "关系",
  "分手",
  "崩溃",
  "焦虑",
  "抑郁",
  "自责",
  "痛苦",
  "失眠",
  "死亡",
  "活着",
  "家庭",
  "创伤",
];

export function routeModel(input: {
  userTier: ModelTier;
  latestMessage: string;
  recentMessageCount: number;
}): RoutedModel {
  if (input.userTier === "light") {
    return {
      tier: "light",
      label: "轻声",
      model: "deepseek-v4-flash",
      reason: "用户选择轻量陪伴挡位",
    };
  }

  if (input.userTier === "deep") {
    return {
      tier: "deep",
      label: "深谈",
      model: "deepseek-v4-pro",
      reason: "用户选择深度复盘挡位",
    };
  }

  if (input.userTier === "balanced") {
    return {
      tier: "balanced",
      label: "均衡",
      model: "deepseek-v4-flash",
      reason: "用户选择默认均衡挡位",
    };
  }

  const message = input.latestMessage.trim();
  const hasDeepSignal = deepTalkSignals.some((signal) => message.includes(signal));
  const needsDeepModel = message.length > 180 || hasDeepSignal || input.recentMessageCount > 18;

  if (needsDeepModel) {
    return {
      tier: "deep",
      label: "自动: 深谈",
      model: "deepseek-v4-pro",
      reason: "自动判断为复杂倾诉或长文本场景",
    };
  }

  return {
    tier: "balanced",
    label: "自动: 均衡",
    model: "deepseek-v4-flash",
    reason: "自动判断为日常聊天场景",
  };
}

export const tierOptions: Array<{ value: ModelTier; label: string; hint: string }> = [
  { value: "auto", label: "自动", hint: "由系统判断" },
  { value: "light", label: "轻声", hint: "轻量陪伴" },
  { value: "balanced", label: "均衡", hint: "日常聊天" },
  { value: "deep", label: "深谈", hint: "复杂复盘" },
];

