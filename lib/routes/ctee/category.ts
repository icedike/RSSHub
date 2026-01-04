import { load } from 'cheerio';
import type { ConnectResult, Options } from 'puppeteer-real-browser';
import { connect } from 'puppeteer-real-browser';

import { config } from '@/config';
import type { Route } from '@/types';
import cache from '@/utils/cache';
import { parseDate } from '@/utils/parse-date';

const baseUrl = 'https://ctee.com.tw';

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
            let verify: boolean | null = null;
            const startDate = Date.now();
            // 等待 60 秒讓 Cloudflare Turnstile 完成驗證
            while (!verify && Date.now() - startDate < 60000) {
                verify = await page.evaluate((sel) => (document.querySelector(sel) ? true : null), selector).catch(() => null);
                await new Promise((r) => setTimeout(r, 1000));
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

export const route: Route = {
    path: '/:category{.+}?',
    name: '分類',
    categories: ['traditional-media'],
    example: '/ctee/finance/fintech',
    parameters: {
        category: '分類路徑，對應網站 URL 結構，例如 `finance/fintech`、`industry/semi`',
    },
    maintainers: ['your-github-id'],
    description: `工商時報新聞分類

| RSS 路徑 | 對應網頁 |
| --- | --- |
| /ctee/finance/fintech | ctee.com.tw/finance/fintech |
| /ctee/finance/bank | ctee.com.tw/finance/bank |
| /ctee/industry/semi | ctee.com.tw/industry/semi |
| /ctee/stock | ctee.com.tw/stock |
| /ctee/news/policy | ctee.com.tw/news/policy |
| /ctee/news/global | ctee.com.tw/news/global |`,
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
            source: ['ctee.com.tw/:category*'],
            target: '/:category',
        },
    ],
    handler: async (ctx) => {
        if (!config.puppeteerRealBrowserService && !config.chromiumExecutablePath) {
            throw new Error('PUPPETEER_REAL_BROWSER_SERVICE or CHROMIUM_EXECUTABLE_PATH is required to use this route.');
        }

        const category = ctx.req.param('category') || 'finance/fintech';
        const url = `${baseUrl}/${category}`;

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

        const html = await getPageWithRealBrowser(url, 'article, .news-list, .article-list', conn);

        if (!html) {
            if (conn) {
                await conn.browser.close();
                conn = null;
            }
            throw new Error('Failed to fetch page. The website may be blocking requests.');
        }

        const $ = load(html);

        // 嘗試多種可能的文章選擇器
        const articleSelectors = [
            'article',
            '.news-item',
            '.article-item',
            '.list-item',
            '[class*="news"]',
            '[class*="article"]',
        ];

        let articles: any[] = [];
        for (const selector of articleSelectors) {
            const found = $(selector).toArray();
            if (found.length > 0) {
                articles = found;
                break;
            }
        }

        const list = articles.slice(0, 20).map((item) => {
            const $item = $(item);
            const $link = $item.find('a').first();
            const link = $link.attr('href');
            const title = $item.find('h2, h3, .title, [class*="title"]').first().text().trim() || $link.text().trim();
            const description = $item.find('p, .desc, .summary, [class*="desc"]').first().text().trim();
            const dateText = $item.find('time, .date, .time, [class*="date"]').first().text().trim();

            return {
                title,
                link: link?.startsWith('http') ? link : `${baseUrl}${link}`,
                description,
                pubDate: dateText ? parseDate(dateText) : undefined,
            };
        }).filter((item) => item.title && item.link);

        // 取得文章全文
        const items = await Promise.all(
            list.map((item) =>
                cache.tryGet(item.link, async () => {
                    try {
                        const detailHtml = await getPageWithRealBrowser(item.link, 'article, .article-content, .content', conn);
                        if (detailHtml) {
                            const $detail = load(detailHtml);
                            const content = $detail('article, .article-content, .content, [class*="content"]').first().html();
                            if (content) {
                                item.description = content;
                            }
                            // 嘗試取得更準確的日期
                            const dateEl = $detail('time, [class*="date"], [class*="time"]').first();
                            const datetime = dateEl.attr('datetime') || dateEl.text().trim();
                            if (datetime) {
                                item.pubDate = parseDate(datetime);
                            }
                            // 取得作者
                            const author = $detail('[class*="author"], .author, .reporter').first().text().trim();
                            if (author) {
                                (item as any).author = author;
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

        // 取得頁面標題
        const pageTitle = $('h1, .page-title, title').first().text().trim() || '工商時報';

        return {
            title: `${pageTitle} - 工商時報`,
            link: url,
            description: '工商時報新聞',
            language: 'zh-TW',
            item: items,
        };
    },
};
