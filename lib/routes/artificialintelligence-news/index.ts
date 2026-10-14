import type { Route } from '@/types';
import ofetch from '@/utils/ofetch';

import { baseUrl, buildApiUrl, parseApiPosts } from './utils';

// 低於 Miniflux 的抓取逾時
const API_TIMEOUT_MS = 15000;

export const route: Route = {
    path: '/',
    name: '最新文章',
    categories: ['new-media'],
    example: '/artificialintelligence-news',
    maintainers: ['icedike'],
    description: `AI News（artificialintelligence-news.com）最新文章，排除 Sponsored Content 業配。

站方 2026-09 起把所有 RSS（/feed/、/feed/rss2/、/feed/atom/）轉址回首頁，改讀 WordPress REST API。`,
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: false,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['www.artificialintelligence-news.com/', 'artificialintelligence-news.com/'],
            target: '/',
        },
    ],
    handler: async () => {
        const posts = await ofetch(buildApiUrl(), { timeout: API_TIMEOUT_MS, retry: 1 });

        return {
            title: 'AI News',
            link: baseUrl,
            description: 'AI News - 企業 AI 應用與政策新聞（排除業配）',
            language: 'en',
            item: parseApiPosts(posts),
        };
    },
};
