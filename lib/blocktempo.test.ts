import { describe, expect, it } from 'vitest';

import { API_PAGE_SIZE, buildApiUrl, cleanContent, parseApiPosts, parsePublishedTime } from '@/routes/blocktempo/utils';

// 測試放在 lib/routes 之外：開發模式的 registry 會把 lib/routes 底下每個 .ts 當路由載入

const post = (overrides: Record<string, unknown> = {}) => ({
    date_gmt: '2026-10-01T05:58:44',
    link: 'https://www.blocktempo.com/september-crypto-hack-losses-766-million-peckshield-certik-worst-month-2026/',
    title: { rendered: '9 月加密駭案狂飆 &#8220;7.66 億鎂&#8221; &amp; 雙案' },
    content: {
        rendered: '<p class="intro_quote">導言</p><p>內文</p><p><a href="https://t.me/blocktemponews"><img src="banner.png"></a></p>',
    },
    _embedded: {
        author: [{ name: '冷麵' }],
        'wp:term': [
            [{ taxonomy: 'category', name: '加密貨幣市場' }],
            [
                { taxonomy: 'post_tag', name: 'Bitget' },
                { taxonomy: 'post_tag', name: '駭客攻擊' },
            ],
        ],
        'wp:featuredmedia': [{ source_url: 'https://image.blocktempo.com/2026/10/cover.webp' }],
    },
    ...overrides,
});

describe('blocktempo parseApiPosts', () => {
    it('把 WordPress API 文章轉成 RSS 項目，網址逐字保留（Miniflux 以網址當 GUID 去重）', () => {
        const [item] = parseApiPosts([post()]);

        expect(item.link).toBe('https://www.blocktempo.com/september-crypto-hack-losses-766-million-peckshield-certik-worst-month-2026/');
        expect(item.title).toBe('9 月加密駭案狂飆 “7.66 億鎂” & 雙案');
        expect(item.author).toBe('冷麵');
        expect(item.category).toEqual(['加密貨幣市場']);
        expect(item.image).toBe('https://image.blocktempo.com/2026/10/cover.webp');
    });

    it('date_gmt 沒有時區標記，必須當 UTC 解讀', () => {
        const [item] = parseApiPosts([post()]);

        expect(item.pubDate).toEqual(new Date(Date.UTC(2026, 9, 1, 5, 58, 44)));
    });

    it('內文移除 Telegram 橫幅，保留正文', () => {
        const [item] = parseApiPosts([post()]);

        expect(item.description).toContain('導言');
        expect(item.description).toContain('內文');
        expect(item.description).not.toContain('t.me/blocktemponews');
    });

    it('沒有作者、分類、封面圖時不帶這些欄位', () => {
        const [item] = parseApiPosts([post({ _embedded: undefined })]);

        expect(item.author).toBeUndefined();
        expect(item.category).toBeUndefined();
        expect(item.image).toBeUndefined();
    });

    it('略過缺網址、日期壞掉、或不是動區網址的文章', () => {
        const items = parseApiPosts([post(), post({ link: undefined }), post({ date_gmt: 'not-a-date' }), post({ link: 'https://evil.example.com/post/' }), post({ title: undefined })]);

        expect(items).toHaveLength(1);
    });

    it('回應不是陣列（例如 Cloudflare 驗證頁）就丟錯，讓呼叫端退回瀏覽器', () => {
        expect(() => parseApiPosts('<!DOCTYPE html><title>Just a moment...</title>')).toThrow();
        expect(() => parseApiPosts({ code: 'rest_forbidden' })).toThrow();
    });
});

describe('blocktempo buildApiUrl', () => {
    it('依年份限定範圍，並一次取 API_PAGE_SIZE 篇', () => {
        const url = new URL(buildApiUrl('2026'));

        expect(url.origin + url.pathname).toBe('https://www.blocktempo.com/wp-json/wp/v2/posts');
        expect(url.searchParams.get('per_page')).toBe(String(API_PAGE_SIZE));
        expect(url.searchParams.get('after')).toBe('2026-01-01T00:00:00');
        expect(url.searchParams.get('before')).toBe('2027-01-01T00:00:00');
        expect(url.searchParams.get('_embed')).toBe('author,wp:term,wp:featuredmedia');
    });
});

describe('blocktempo parsePublishedTime', () => {
    it('讀 article:published_time，不讀 JSON-LD 的 datePublished（後者把 UTC 標成 +08:00，會早 8 小時）', () => {
        const html = `
            <script type="application/ld+json">{"datePublished":"2026-10-01T05:58:44+08:00"}</script>
            <meta property="article:published_time" content="2026-10-01T13:58:44+08:00" />`;

        expect(parsePublishedTime(html)).toEqual(new Date(Date.UTC(2026, 9, 1, 5, 58, 44)));
    });

    it('沒有或格式壞掉時回 undefined', () => {
        expect(parsePublishedTime('<html></html>')).toBeUndefined();
        expect(parsePublishedTime('<meta property="article:published_time" content="garbage" />')).toBeUndefined();
    });
});

describe('blocktempo cleanContent', () => {
    it('移除分享鈕、廣告、相關文章、script 與 style', () => {
        const html = cleanContent('<p>正文</p><div class="jeg_share_button">分享</div><div class="jeg_ad">廣告</div><div class="jnews_inline_related_post">相關</div><script>x()</script><style>p{}</style>');

        expect(html).toContain('正文');
        for (const noise of ['分享', '廣告', '相關', 'x()', 'p{}']) {
            expect(html).not.toContain(noise);
        }
    });
});
