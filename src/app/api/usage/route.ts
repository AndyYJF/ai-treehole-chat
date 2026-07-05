import { NextResponse } from "next/server";
import { clearModelUsage, getModelUsageSummary, listModelUsage } from "@/lib/model-usage";
import { getServerUserId } from "@/lib/server-user";

export const runtime = "nodejs";

export async function GET() {
  const userId = getServerUserId();

  return NextResponse.json({
    summary: await getModelUsageSummary(userId),
    recent: await listModelUsage(userId, 20),
  });
}

export async function DELETE() {
  const userId = getServerUserId();

  return NextResponse.json({
    summary: await clearModelUsage(userId),
    recent: [],
  });
}
