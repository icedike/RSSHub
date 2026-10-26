import { describe, expect, it } from 'vitest';

import { assertPostArray, buildApiUrl, buildCategoriesUrl, parseApiPosts, toCategoryNames } from '@/routes/artificialintelligence-news/utils';

// 測試放在 lib/routes 之外：開發模式的 registry 會把 lib/routes 底下每個 .ts 當路由載入

const CATEGORY_NAMES = { 3350: 'AI Business Strategy', 3335: 'AI in Action', 3195: 'Sponsored Content' };

const post = (overrides: Record<string, unknown> = {}) => ({
    id: 114976,
    date_gmt: '2026-10-26T12:30:15',
    guid: { rendered: 'https://www.artificialintelligence-news.com/?p=114976' },
    link: 'https://www.artificialintelligence-news.com/news/argyll-uk-ai-held-back-grid-queue-microsoft-exits-nscale-site/',
    title: { rendered: 'Argyll warns UK AI held back by grid queue &#8211; &amp; more' },
    content: { rendered: '<p>內文</p><script>track()</script>' },
    categories: [3350, 3335],
    authors: [{ display_name: 'Ryan Daws' }],
    _embedded: {
        'wp:featuredmedia': [{ source_url: 'https://www.artificialintelligence-news.com/wp-content/uploads/2026/10/cover.jpg' }],
    },
    ...overrides,
});

describe('artificialintelligence-news buildApiUrl', () => {
    it('不嵌入 wp:term：每個 term 都帶 Yoast SEO 欄位，20 篇會膨脹到 2 MB', () => {
        const url = new URL(buildApiUrl());

        expect(url.searchParams.get('_embed')).toBe('wp:featuredmedia');
        expect(url.searchParams.get('_fields')?.split(',')).toEqual(expect.arrayContaining(['authors', 'categories', '_links', '_embedded']));
        expect(url.searchParams.get('per_page')).toBe('20');
        expect(url.searchParams.get('categories_exclude')).toBe('3195');
    });
});

describe('artificialintelligence-news buildCategoriesUrl', () => {
    it('一次取全站分類的 id 與名稱', () => {
        const url = new URL(buildCategoriesUrl());

        expect(url.pathname).toBe('/wp-json/wp/v2/categories');
        expect(url.searchParams.get('per_page')).toBe('100');
        expect(url.searchParams.get('_fields')).toBe('id,name');
    });
});

describe('artificialintelligence-news toCategoryNames', () => {
    it('轉成 id → 名稱，名稱解 HTML entity', () => {
        expect(
            toCategoryNames([
                { id: 3368, name: 'Governance, Regulation &amp; Policy' },
                { id: 3195, name: 'Sponsored Content' },
            ])
        ).toEqual({ 3368: 'Governance, Regulation & Policy', 3195: 'Sponsored Content' });
    });

    it('略過缺 id 或名稱的項目', () => {
        expect(toCategoryNames([{ id: 1 }, { name: 'x' }, null, { id: 2, name: 'OK' }])).toEqual({ 2: 'OK' });
    });

    it('不是陣列就丟錯', () => {
        expect(() => toCategoryNames('<html>blocked</html>')).toThrow(/category array/);
    });

    it('空陣列或全部格式不符就丟錯，不讓空的名稱表被快取一整天', () => {
        expect(() => toCategoryNames([])).toThrow(/no usable categories/);
        expect(() => toCategoryNames([{ id: '3195', name: 'Sponsored Content' }])).toThrow(/no usable categories/);
    });
});

describe('artificialintelligence-news assertPostArray', () => {
    it('是陣列就通過', () => {
        expect(() => assertPostArray([], { status: 200, contentType: 'application/json' })).not.toThrow();
    });

    it('不是陣列時，錯誤訊息帶狀態碼、content-type 與回應開頭，方便從 log 判斷是誰擋的', () => {
        const body = `<!DOCTYPE html>\n<html><head>\n  <meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2Fwp-json">${'x'.repeat(1000)}`;

        expect(() => assertPostArray(body, { status: 202, contentType: 'text/html; charset=UTF-8' })).toThrow(TypeError);

        let message = '';
        try {
            assertPostArray(body, { status: 202, contentType: 'text/html; charset=UTF-8' });
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toContain('did not return a post array');
        expect(message).toContain('status=202');
        expect(message).toContain('content-type=text/html; charset=UTF-8');
        expect(message).toContain('<html><head> <meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/');
        expect(message).not.toContain('\n');
        expect(message.length).toBeLessThan(500);
    });

    it('回的是 JSON 物件時，把物件內容放進錯誤訊息', () => {
        expect(() => assertPostArray({ code: 'rest_forbidden' }, { status: 200, contentType: 'application/json' })).toThrow(/\{"code":"rest_forbidden"\}/);
    });
});

describe('artificialintelligence-news parseApiPosts', () => {
    it('把 WordPress API 文章轉成 RSS 項目', () => {
        const [item] = parseApiPosts([post()], CATEGORY_NAMES);

        expect(item.title).toBe('Argyll warns UK AI held back by grid queue – & more');
        expect(item.link).toBe('https://www.artificialintelligence-news.com/news/argyll-uk-ai-held-back-grid-queue-microsoft-exits-nscale-site/');
        expect(item.pubDate).toEqual(new Date(Date.UTC(2026, 9, 26, 12, 30, 15)));
        expect(item.author).toBe('Ryan Daws');
        expect(item.category).toEqual(['AI Business Strategy', 'AI in Action']);
        expect(item.image).toBe('https://www.artificialintelligence-news.com/wp-content/uploads/2026/10/cover.jpg');
        expect(item.description).toContain('內文');
        expect(item.description).not.toContain('track()');
    });

    it('guid 原樣輸出 guid.rendered；缺 guid 時用 ?p=<id> 組，不退回文章網址', () => {
        const [withGuid] = parseApiPosts([post()], CATEGORY_NAMES);
        const [withoutGuid] = parseApiPosts([post({ guid: undefined })], CATEGORY_NAMES);

        expect(withGuid.guid).toBe('https://www.artificialintelligence-news.com/?p=114976');
        expect(withoutGuid.guid).toBe('https://www.artificialintelligence-news.com/?p=114976');
    });

    it('多位作者以逗號串接', () => {
        const [item] = parseApiPosts([post({ authors: [{ display_name: 'A' }, { display_name: 'B' }] })], CATEGORY_NAMES);

        expect(item.author).toBe('A, B');
    });

    it('分類名稱是 Sponsored 的業配文不收（API 層排除失效時的第二道防線）', () => {
        expect(parseApiPosts([post({ categories: [3350, 3195] })], CATEGORY_NAMES)).toEqual([]);
    });

    it('查不到名稱的分類略過；沒有作者、分類、封面圖時不帶這些欄位', () => {
        const [item] = parseApiPosts([post({ categories: [9999], authors: [], _embedded: undefined })], CATEGORY_NAMES);

        expect(item.category).toBeUndefined();
        expect(item.author).toBeUndefined();
        expect(item.image).toBeUndefined();
    });

    it('沒有分類名稱表時照樣輸出，只是不帶分類', () => {
        const [item] = parseApiPosts([post()], {});

        expect(item.category).toBeUndefined();
        expect(item.title).toContain('Argyll');
    });

    it('API 有回文章卻一篇都解析不了就丟錯，不輸出合法但永遠是空的 feed', () => {
        expect(() => parseApiPosts([post({ date_gmt: 'bad' })], CATEGORY_NAMES)).toThrow(/none could be parsed/);
    });

    it('不是陣列就丟錯', () => {
        expect(() => parseApiPosts('<html></html>', CATEGORY_NAMES)).toThrow(/did not return a post array/);
    });
});
