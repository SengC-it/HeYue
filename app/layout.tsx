import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "HeYue｜合约信号观察站",
  description: "HeYue Binance USDT-M 合约机会扫描、风险评分与 PAPER 观察系统。仅提供邮件信号，不自动下单。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
