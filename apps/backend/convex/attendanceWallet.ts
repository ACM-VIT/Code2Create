"use node";

import { v } from "convex/values";

import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import {
  createAppleWalletPass,
  type ExternalEventPassDetails,
  verifyAppleWalletDownloadToken,
} from "./lib/externalEventPassWallet";

export const buildApplePass = internalAction({
  args: { token: v.string() },
  returns: v.bytes(),
  handler: async (ctx, args) => {
    const passId = await verifyAppleWalletDownloadToken(args.token);
    const details: ExternalEventPassDetails = await ctx.runAction(
      internal.attendanceActions.externalPassForWallet,
      { passId },
    );
    const bytes = createAppleWalletPass(details);
    const owned = new Uint8Array(bytes.byteLength);
    owned.set(bytes);
    return owned.buffer;
  },
});
