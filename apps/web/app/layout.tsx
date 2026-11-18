import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: '鱼趣知识库', description: '边听播客，随时提问；手机与网页同步收听进度和对话。' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
