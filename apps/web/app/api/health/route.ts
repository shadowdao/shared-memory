import { NextResponse } from "next/server";
import { pg } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + DB connectivity probe for the docker healthcheck.
 * Returns 200 only if Postgres responds within the request timeout.
 */
export async function GET() {
  try {
    await pg`SELECT 1`;
    return NextResponse.json({ status: "ok", db: "up" });
  } catch (e) {
    return NextResponse.json(
      { status: "degraded", db: "down", error: e instanceof Error ? e.message : "unknown" },
      { status: 503 },
    );
  }
}
