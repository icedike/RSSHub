import { load } from 'cheerio';
import type { ConnectResult, Options } from 'puppeteer-real-browser';
import { connect } from 'puppeteer-real-browser';

import { config } from '@/config';
import type { Route } from '@/types';
import cache from '@/utils/cache';
import { parseDate } from '@/utils/parse-date';

const baseUrl = 'https://www.blocktempo.com';

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
        if (!config.puppeteerRealBrowserService && !config.chromiumExecutablePath) {
            throw new Error('PUPPETEER_REAL_BROWSER_SERVICE or CHROMIUM_EXECUTABLE_PATH is required to use this route.');
        }

        const currentYear = new Date().getFullYear().toString();
        const year = ctx.req.param('year') || currentYear;
        const url = `${baseUrl}/${year}/`;

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

                return {
                    title,
                    link: link?.startsWith('http') ? link : `${baseUrl}${link}`,
                    description,
                    pubDate: dateText ? parseDate(dateText) : undefined,
                    author,
                    image,
                };
            })
            .filter((item) => item.title && item.link);

        // 取得文章全文
        const items = await Promise.all(
            list.map((item) =>
                cache.tryGet(item.link, async () => {
                    try {
                        const detailHtml = await getPageWithRealBrowser(item.link, '.entry-content', conn);
                        if (detailHtml) {
                            const $detail = load(detailHtml);

                            // 移除廣告和不必要元素
                            $detail('.jeg_share_button').remove();
                            $detail('.jeg_post_tags').remove();
                            $detail('.jeg_ad').remove();
                            $detail('.jnews_inline_related_post').remove();
                            $detail('.jeg_authorbox').remove();
                            $detail('.jnews_prev_next_container').remove();
                            // 移除 Telegram banner
                            $detail('a[href*="t.me/blocktemponews"]').remove();
                            $detail('script').remove();
                            $detail('style').remove();

                            // 取得文章內容
                            const content = $detail('.entry-content').html();
                            if (content) {
                                item.description = content;
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
                                (item as any).category = categories;
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

        return {
            title: `動區動趨 BlockTempo - ${year}`,
            link: url,
            description: '動區動趨 - 最具影響力的區塊鏈新聞媒體',
            language: 'zh-TW',
            item: items,
        };
    },
};
