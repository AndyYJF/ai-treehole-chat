import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import {
  appendChatMessages,
  claimChatTurn,
  completeChatTurn,
  ensureActiveChatThread,
  failChatTurn,
  listChatMessages,
} from "./chat-history";

describe("chat turn idempotency", () => {
  it("deduplicates messages and replays a completed turn", async () => {
    const userId = `test-${randomUUID()}`;
    const clientTurnId = randomUUID();
    const thread = await ensureActiveChatThread(userId);
    const firstClaim = await claimChatTurn(userId, thread.id, clientTurnId);

    expect(firstClaim.state).toBe("claimed");

    const userMessage = {
      id: firstClaim.turn.userMessageId,
      turnId: firstClaim.turn.id,
      role: "user" as const,
      content: "测试消息",
      context: {
        visionWarning: "测试识图失败",
      },
    };
    await appendChatMessages(userId, thread.id, [userMessage]);
    await appendChatMessages(userId, thread.id, [userMessage]);
    await appendChatMessages(userId, thread.id, [
      {
        id: firstClaim.turn.assistantMessageId,
        turnId: firstClaim.turn.id,
        role: "assistant",
        content: "测试回复",
      },
    ]);
    await completeChatTurn(userId, clientTurnId);

    const messages = await listChatMessages(userId, thread.id);
    expect(messages.filter((message) => message.id === firstClaim.turn.userMessageId)).toHaveLength(1);
    expect(messages.find((message) => message.id === firstClaim.turn.userMessageId)?.context.visionWarning).toBe(
      "测试识图失败",
    );
    expect(messages.filter((message) => message.id === firstClaim.turn.assistantMessageId)).toHaveLength(1);

    const replay = await claimChatTurn(userId, thread.id, clientTurnId);
    expect(replay.state).toBe("completed");
  });

  it("allows a failed turn to be claimed again without changing message ids", async () => {
    const userId = `test-${randomUUID()}`;
    const clientTurnId = randomUUID();
    const thread = await ensureActiveChatThread(userId);
    const firstClaim = await claimChatTurn(userId, thread.id, clientTurnId);

    await failChatTurn(userId, clientTurnId);
    const retry = await claimChatTurn(userId, thread.id, clientTurnId);

    expect(retry.state).toBe("claimed");
    expect(retry.turn.userMessageId).toBe(firstClaim.turn.userMessageId);
    expect(retry.turn.assistantMessageId).toBe(firstClaim.turn.assistantMessageId);
  });

  it("rejects concurrent processing of the same turn", async () => {
    const userId = `test-${randomUUID()}`;
    const clientTurnId = randomUUID();
    const thread = await ensureActiveChatThread(userId);

    await claimChatTurn(userId, thread.id, clientTurnId);
    const duplicate = await claimChatTurn(userId, thread.id, clientTurnId);

    expect(duplicate.state).toBe("in_progress");
  });
});
