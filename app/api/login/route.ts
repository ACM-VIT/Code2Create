import { NextRequest, NextResponse } from "next/server";
import { createSessionValue, passwordsMatch, sessionCookie } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const expected = process.env.DOCS_PASSWORD;
  const secret = process.env.AUTH_SECRET;
  if (!expected || !secret) {
    return new NextResponse("Authentication is not configured.", { status: 503 });
  }

  const form = await request.formData();
  const supplied = String(form.get("password") ?? "");
  if (!(await passwordsMatch(supplied, expected))) {
    return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  }

  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.cookies.set(sessionCookie.name, await createSessionValue(secret), {
    ...sessionCookie.options,
    maxAge: sessionCookie.maxAge,
  });
  return response;
}
