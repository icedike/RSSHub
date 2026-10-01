import { load } from 'cheerio';
import type { ConnectResult, Options } from 'puppeteer-real-browser';
import { connect } from 'puppeteer-real-browser';

import { config } from '@/config';
import type { DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';

import { baseUrl, buildApiUrl, cleanContent, parseApiPosts, parsePublishedTime } from './utils';

// 低於 Miniflux 的抓取逾時，API 卡住時還有機會在同一次請求內退回瀏覽器
const API_TIMEOUT_MS = 15000;

const realBrowserOption: Options = {
    args: ['--start-maximized'],
    turnstile: true,
    headless: false,
    customConfig: {
        chromePath: config.chromiumExecutablePath,
    },
    connectOption: {
        defaultViewport: null,
    },
    plugins: [],
};

async function getPageWithRealBrowser(url: string, selector: string, conn: ConnectResult | null): Promise<string> {
    try {
        if (conn) {
            const page = conn.page;
            await page.goto(url, { timeout: 60000 });
            // 等待 60 秒讓 Cloudflare Turnstile 完成驗證（waitForSelector 會跨驗證後的頁面跳轉繼續等）
            try {
                await page.waitForSelector(selector, { timeout: 60000 });
            } catch (error) {
                // 逾時照舊回傳目前頁面，交給呼叫端判斷有沒有內容
                logger.warn(`blocktempo: ${selector} not found on ${url} within 60s: ${error}`);
            }
            return await page.content();
        } else {
            const res = await fetch(`${config.puppeteerRealBrowserService}?url=${encodeURIComponent(url)}&selector=${encodeURIComponent(selector)}`, {
                signal: AbortSignal.timeout(60000),
            });
            const json = await res.json();
            return (json.data?.at(0) || '') as string;
        }
    } catch {
        return '';
    }
}

// 主路徑：WordPress REST API。有精確發布時間與全文，平常不必過 Cloudflare 驗證。
async function fetchFromApi(year: string): Promise<DataItem[]> {
    const posts = await ofetch(buildApiUrl(year), { timeout: API_TIMEOUT_MS, retry: 1 });
    return parseApiPosts(posts);
}

// 備援路徑：API 被擋或壞掉時，用瀏覽器過 Turnstile 讀列表頁與文章頁（2026-10-01 前的唯一做法）。
async function fetchFromBrowser(url: string): Promise<DataItem[]> {
    if (!config.puppeteerRealBrowserService && !config.chromiumExecutablePath) {
        throw new Error('PUPPETEER_REAL_BROWSER_SERVICE or CHROMIUM_EXECUTABLE_PATH is required to use this route.');
    }

    let conn: ConnectResult | null = null;

    if (!config.puppeteerRealBrowserService) {
        conn = await connect(realBrowserOption);
        // 120 秒後自動關閉瀏覽器，避免資源洩漏
        setTimeout(async () => {
            if (conn) {
                await conn.browser.close();
            }
        }, 120000);
    }

    // 等待文章列表載入
    const html = await getPageWithRealBrowser(url, 'article.jeg_post', conn);

    if (!html) {
        if (conn) {
            await conn.browser.close();
            conn = null;
        }
        throw new Error('Failed to fetch page. The website may be blocking requests.');
    }

    const $ = load(html);

    // 解析文章卡片
    const list = $('article.jeg_post')
        .toArray()
        .slice(0, 20)
        .map((item) => {
            const $item = $(item);
            const $titleLink = $item.find('h3.jeg_post_title a');
            const link = $titleLink.attr('href');
            const title = $titleLink.text().trim();
            const description = $item.find('.jeg_post_excerpt p').text().trim();
            const dateText = $item.find('.jeg_meta_date a').text().trim();
            const author = $item.find('.jeg_meta_author a').text().trim();
            const image = $item.find('.jeg_thumb img').attr('src');

            const listItem: DataItem = {
                title,
                link: link?.startsWith('http') ? link : `${baseUrl}${link}`,
                description,
                // 列表頁只有日期（00:00），文章頁讀得到時會被 article:published_time 取代
                pubDate: dateText ? parseDate(dateText) : undefined,
                author,
                image,
            };
            return listItem;
        })
        .filter((item) => item.title && item.link);

    // 取得文章全文
    const items = await Promise.all(
        list.map((item) =>
            cache.tryGet(item.link as string, async () => {
                try {
                    const detailHtml = await getPageWithRealBrowser(item.link as string, '.entry-content', conn);
                    if (detailHtml) {
                        const $detail = load(detailHtml);

                        const content = $detail('.entry-content').html();
                        if (content) {
                            item.description = cleanContent(content);
                        }

                        const publishedTime = parsePublishedTime(detailHtml);
                        if (publishedTime) {
                            item.pubDate = publishedTime;
                        }

                        // 取得分類
                        const categories: string[] = [];
                        $detail('.jeg_meta_category a').each((_, el) => {
                            const cat = $detail(el).text().trim();
                            if (cat) {
                                categories.push(cat);
                            }
                        });
                        if (categories.length > 0) {
                            item.category = categories;
                        }
                    }
                } catch {
                    // 忽略錯誤，使用列表頁的資訊
                }
                return item;
            })
        )
    );

    if (conn) {
        await conn.browser.close();
    }

    return items as DataItem[];
}

export const route: Route = {
    path: '/:year?',
    name: '年度文章',
    categories: ['finance'],
    example: '/blocktempo/2026',
    parameters: {
        year: '年份，預設為當前年份，例如 `2026`、`2025`',
    },
    maintainers: ['your-github-id'],
    description: `動區動趨 BlockTempo 區塊鏈新聞

| RSS 路徑 | 對應網頁 |
| --- | --- |
| /blocktempo/2026 | blocktempo.com/2026/ |
| /blocktempo/2025 | blocktempo.com/2025/ |
| /blocktempo | blocktempo.com/{當前年份}/ |`,
    features: {
        requireConfig: false,
        requirePuppeteer: true,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
    },
    radar: [
        {
            source: ['blocktempo.com/:year'],
            target: '/:year',
        },
    ],
    handler: async (ctx) => {
        const currentYear = new Date().getFullYear().toString();
        const year = ctx.req.param('year') || currentYear;
        const url = `${baseUrl}/${year}/`;

        let items: DataItem[] = [];
        try {
            items = await fetchFromApi(year);
        } catch (error) {
            logger.warn(`blocktempo: WordPress API failed, falling back to browser: ${error}`);
        }

        if (items.length === 0) {
            items = await fetchFromBrowser(url);
        }

        return {
            title: `動區動趨 BlockTempo - ${year}`,
            link: url,
            description: '動區動趨 - 最具影響力的區塊鏈新聞媒體',
            language: 'zh-TW',
            item: items,
        };
    },
};
