// Popup to background messaging.
import type { WalletRequest, WalletResponse, ResponseMap } from "../../../core/messages";

export async function call<K extends WalletRequest["type"]>(
  msg: Extract<WalletRequest, { type: K }>,
): Promise<ResponseMap[K]> {
  const res = (await chrome.runtime.sendMessage(msg)) as WalletResponse<ResponseMap[K]>;
  if (!res) throw new Error("The wallet did not respond. Try reopening the popup.");
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
