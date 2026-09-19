import type { Metadata } from 'next';
import { IBM_Plex_Sans_Condensed, Inter } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

// The developer's theme asks for Inter; the flow.js runtime chrome uses Plex Condensed.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const plex = IBM_Plex_Sans_Condensed({
    subsets: ['latin'],
    weight: ['400', '500', '600'],
    variable: '--font-chrome',
});

export const metadata: Metadata = {
    title: 'flow.js',
    description:
        'An adaptive interface runtime: capabilities in, a continuously improving interface out.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
    return (
        <html lang="en" className={`${inter.variable} ${plex.variable}`}>
            <body>{children}</body>
        </html>
    );
}
