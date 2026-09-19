import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title: 'RailGuard AI — Railway condition analysis', description: 'Analyse railway recordings, inspect the evidence and export predictions.'};
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
