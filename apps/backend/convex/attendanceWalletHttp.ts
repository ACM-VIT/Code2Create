import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";

function response(message: string, status: number) {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export const applePassEndpoint = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return response("This Apple Wallet link is invalid.", 400);
  try {
    const pass = await ctx.runAction(internal.attendanceWallet.buildApplePass, { token });
    return new Response(pass, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apple.pkpass",
        "Content-Disposition": 'attachment; filename="code2create-event-pass.pkpass"',
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return response("This Apple Wallet pass is unavailable or the link has expired.", 404);
  }
});
