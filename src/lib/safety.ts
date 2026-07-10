export type SafetyRiskLevel = "none" | "concern" | "urgent";

export type SafetyAssessment = {
  level: SafetyRiskLevel;
  reason: string;
};

const harmTerms = [
  "自杀",
  "结束生命",
  "伤害自己",
  "伤害别人",
  "伤害他人",
  "不想活",
  "死了算了",
];

const urgentPatterns = [
  /(?:现在|马上|今晚|已经|正在).{0,16}(?:自杀|结束生命|伤害自己|伤害别人|伤害他人)/u,
  /(?:准备|打算|决定|就要).{0,10}(?:自杀|结束生命|伤害自己|伤害别人|伤害他人)/u,
  /(?:已经|刚刚).{0,8}(?:吞药|割腕|跳楼|上吊|开枪)/u,
  /(?:站在|到了).{0,8}(?:楼顶|桥边|铁轨)/u,
];

const negatedPatterns = [
  /没有.{0,8}(?:自杀|伤害自己|伤害他人).{0,6}(?:想法|打算|计划)/u,
  /不(?:会|打算|准备|想要)(?:自杀|伤害自己|伤害他人)/u,
];

export function assessSafetyRisk(message: string): SafetyAssessment {
  const compact = message.replace(/\s+/g, "").trim();
  if (!compact || negatedPatterns.some((pattern) => pattern.test(compact))) {
    return { level: "none", reason: "未发现当前伤害风险信号" };
  }

  if (urgentPatterns.some((pattern) => pattern.test(compact))) {
    return { level: "urgent", reason: "检测到可能的即时伤害风险表达" };
  }

  if (harmTerms.some((term) => compact.includes(term))) {
    return { level: "concern", reason: "检测到需要温和确认安全状况的表达" };
  }

  return { level: "none", reason: "未发现当前伤害风险信号" };
}

export function formatSafetyContext(assessment: SafetyAssessment) {
  if (assessment.level === "none") return "本轮未触发额外安全流程。";

  return [
    `风险级别：${assessment.level}`,
    `原因：${assessment.reason}`,
    assessment.level === "urgent"
      ? "优先确认用户此刻是否安全、是否已经采取行动、是否能联系身边可信任的人；保持简短、直接、陪伴，不讨论实施细节。"
      : "温和确认这句话是否代表用户当前真实处境，不要夸大或直接下结论。",
  ].join("\n");
}
