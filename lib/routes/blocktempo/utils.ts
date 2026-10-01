import { load } from 'cheerio';

import type { DataItem } from '@/types';

export const baseUrl = 'https://www.blocktempo.com';

// 一次取 50 篇：動區平均每天約 29 篇，50 篇約涵蓋 40 小時，
// 中斷十幾個小時後恢復也補得回來（原本列表頁只給 20 篇，2026-09-30 中斷時漏了 5 篇）
export const API_PAGE_SIZE = 50;

const NOISE_SELECTORS = ['.jeg_share_button', '.jeg_post_tags', '.jeg_ad', '.jnews_inline_related_post', '.jeg_authorbox', '.jnews_prev_next_container', 'a[href*="t.me/blocktemponews"]', 'script', 'style'];

export const buildApiUrl = (year: string, perPage: number = API_PAGE_SIZE): string => {
    const url = new URL(`${baseUrl}/wp-json/wp/v2/posts`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('after', `${year}-01-01T00:00:00`);
    url.searchParams.set('before', `${Number(year) + 1}-01-01T00:00:00`);
    url.searchParams.set('_embed', 'author,wp:term,wp:featuredmedia');
    url.searchParams.set('_fields', 'date_gmt,link,title,content,_links,_embedded');
    return url.toString();
};

export const cleanContent = (html: string): string => {
    const $ = load(html, null, false);
    for (const selector of NOISE_SELECTORS) {
        $(selector).remove();
    }
    return $.html();
};

const decodeEntities = (text: string): string => load(text, null, false).text().trim();

// WordPress 的 date_gmt 沒有時區標記（例：2026-10-01T05:58:44），直接 new Date() 會被當本地時間
const parseGmtDate = (value: unknown): Date | undefined => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
        return undefined;
    }
    const date = new Date(`${value}Z`);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

type WpTerm = { taxonomy?: unknown; name?: unknown };

const extractCategories = (terms: unknown): string[] | undefined => {
    if (!Array.isArray(terms)) {
        return undefined;
    }
    const names = (terms.flat() as WpTerm[]).filter((term) => term?.taxonomy === 'category' && typeof term.name === 'string').map((term) => decodeEntities(term.name as string));
    return names.length > 0 ? names : undefined;
};

const toItem = (post: any): DataItem | undefined => {
    const link = post?.link;
    const title = post?.title?.rendered;
    const pubDate = parseGmtDate(post?.date_gmt);
    // 網址逐字保留：Miniflux 以 RSS guid（RSSHub 預設＝link）去重，改寫網址會讓同一篇重複進站
    if (typeof link !== 'string' || !link.startsWith(`${baseUrl}/`) || typeof title !== 'string' || !pubDate) {
        return undefined;
    }

    const embedded = post._embedded ?? {};
    const author = embedded.author?.[0]?.name;
    const image = embedded['wp:featuredmedia']?.[0]?.source_url;
    const content = post.content?.rendered;

    return {
        title: decodeEntities(title),
        link,
        pubDate,
        description: typeof content === 'string' ? cleanContent(content) : undefined,
        author: typeof author === 'string' ? author : undefined,
        category: extractCategories(embedded['wp:term']),
        image: typeof image === 'string' ? image : undefined,
    };
};

export const parseApiPosts = (posts: unknown): DataItem[] => {
    if (!Array.isArray(posts)) {
        throw new TypeError('BlockTempo WordPress API did not return a post array');
    }
    return posts.map((post) => toItem(post)).filter((item): item is DataItem => item !== undefined);
};

// 給瀏覽器備援路徑用：文章頁的 article:published_time 時區正確；
// JSON-LD 的 datePublished 把 UTC 時間標成 +08:00（2026-10-01 實測），會早 8 小時，不可用
export const parsePublishedTime = (html: string): Date | undefined => {
    const value = load(html)('meta[property="article:published_time"]').attr('content');
    if (!value) {
        return undefined;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date;
};
