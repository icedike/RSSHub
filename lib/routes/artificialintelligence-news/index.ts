import type { Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';

import type { CategoryNames } from './utils';
import { assertPostArray, baseUrl, buildApiUrl, buildCategoriesUrl, parseApiPosts, toCategoryNames } from './utils';

// 低於 Miniflux 的抓取逾時
const API_TIMEOUT_MS = 15000;

// 分類幾乎不變，一天查一次，不必每輪都多打站方一次。refresh=false：命中不續期，到期一定重查
const CATEGORY_CACHE_SECONDS = 24 * 60 * 60;

const fetchPosts = async (): Promise<unknown[]> => {
    const response = await ofetch.raw(buildApiUrl(), { timeout: API_TIMEOUT_MS, retry: 1 });
    const posts: unknown = response._data;
    assertPostArray(posts, { status: response.status, contentType: response.headers.get('content-type') });
    return posts;
};

// 分類名稱只用來輸出分類、再擋一次業配（API 層已排除）；查不到時文章照出，不讓整個 feed 跟著壞
const fetchCategoryNames = async (): Promise<CategoryNames> => {
    try {
        return await cache.tryGet(buildCategoriesUrl(), async () => toCategoryNames(await ofetch(buildCategoriesUrl(), { timeout: API_TIMEOUT_MS, retry: 1 })), CATEGORY_CACHE_SECONDS, false);
    } catch (error) {
        logger.warn(`AI News category lookup failed, items will have no categories: ${error}`);
        return {};
    }
};

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
        const [posts, categoryNames] = await Promise.all([fetchPosts(), fetchCategoryNames()]);

        return {
            title: 'AI News',
            link: baseUrl,
            description: 'AI News - 企業 AI 應用與政策新聞（排除業配）',
            language: 'en',
            item: parseApiPosts(posts, categoryNames),
        };
    },
};
