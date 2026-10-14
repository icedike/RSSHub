import { load } from 'cheerio';

import type { DataItem } from '@/types';

export const baseUrl = 'https://www.artificialintelligence-news.com';

// 一次取 20 篇：近期平均每天約 1–2 篇，20 篇約涵蓋兩週，中斷幾天後恢復也補得回來
export const API_PAGE_SIZE = 20;

// 「Sponsored Content」分類（業配文，作者多是 SEO 代操公司）：近 100 篇佔 17 篇，不是新聞，不收。
// 先在 API 層排除，分類 id 若哪天變了，toItem 再用分類名稱擋一次
export const SPONSORED_CATEGORY_ID = 3195;
const SPONSORED_NAME = /sponsored/i;

const NOISE_SELECTORS = ['script', 'style', 'iframe'];

export const buildApiUrl = (perPage: number = API_PAGE_SIZE): string => {
    const url = new URL(`${baseUrl}/wp-json/wp/v2/posts`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('categories_exclude', String(SPONSORED_CATEGORY_ID));
    url.searchParams.set('_embed', 'author,wp:term,wp:featuredmedia');
    url.searchParams.set('_fields', 'id,date_gmt,guid,link,title,content,_links,_embedded');
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

// WordPress 的 date_gmt 沒有時區標記（例：2026-10-13T10:00:00），直接 new Date() 會被當本地時間
const parseGmtDate = (value: unknown): Date | undefined => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
        return undefined;
    }
    const date = new Date(`${value}Z`);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

type WpTerm = { taxonomy?: unknown; name?: unknown };

const termNames = (terms: unknown, taxonomy: string): string[] => {
    if (!Array.isArray(terms)) {
        return [];
    }
    return (terms.flat() as WpTerm[]).filter((term) => term?.taxonomy === taxonomy && typeof term.name === 'string').map((term) => decodeEntities(term.name as string));
};

// 作者在 _embedded.author 拿不到名字（回 null），站方用 Co-Authors 外掛把作者存成 author 分類
const extractAuthor = (embedded: any): string | undefined => {
    const name = embedded.author?.[0]?.name;
    if (typeof name === 'string' && name) {
        return name;
    }
    const names = termNames(embedded['wp:term'], 'author');
    return names.length > 0 ? names.join(', ') : undefined;
};

// 🔴 guid 必須與 WordPress 原生 feed 的 <guid> 逐字相同：Miniflux 以 guid 的 hash 去重，
// 2026-09-25 前由原生 /feed/ 收進來的文章都是 sha256(guid.rendered)（實測＝`https://www.artificialintelligence-news.com/?p=<id>`）。
// 所以原樣輸出、不比對前綴；缺 guid 時用 WordPress 預設格式自己組，絕不退回文章網址（RSSHub 模板的預設），
// 否則同一篇會以新 hash 重複進站，而且不會有任何錯誤訊息
const resolveGuid = (post: any): string | undefined => {
    const rendered = post?.guid?.rendered;
    if (typeof rendered === 'string' && rendered) {
        return rendered;
    }
    return Number.isInteger(post?.id) ? `${baseUrl}/?p=${post.id}` : undefined;
};

type ParseResult = { item?: DataItem; sponsored?: boolean };

const toItem = (post: any): ParseResult => {
    const link = post?.link;
    const title = post?.title?.rendered;
    const pubDate = parseGmtDate(post?.date_gmt);
    const guid = resolveGuid(post);
    if (typeof link !== 'string' || !/^https?:\/\//.test(link) || typeof title !== 'string' || !pubDate || !guid) {
        return {};
    }

    const embedded = post._embedded ?? {};
    const categories = termNames(embedded['wp:term'], 'category');
    if (categories.some((name) => SPONSORED_NAME.test(name))) {
        return { sponsored: true };
    }

    const image = embedded['wp:featuredmedia']?.[0]?.source_url;
    const content = post.content?.rendered;

    return {
        item: {
            title: decodeEntities(title),
            link,
            guid,
            pubDate,
            description: typeof content === 'string' ? cleanContent(content) : undefined,
            author: extractAuthor(embedded),
            category: categories.length > 0 ? categories : undefined,
            image: typeof image === 'string' ? image : undefined,
        },
    };
};

export const parseApiPosts = (posts: unknown): DataItem[] => {
    if (!Array.isArray(posts)) {
        throw new TypeError('AI News WordPress API did not return a post array');
    }
    const results = posts.map((post) => toItem(post));
    const items = results.map((result) => result.item).filter((item): item is DataItem => item !== undefined);
    // API 有回文章、卻因欄位格式不符被全部丟掉 ⇒ 站方改了資料格式。throw 讓 Miniflux 記 parse error、
    // feed-health 點名，不要輸出一個「合法但永遠是空的」feed（那樣要等 7 天無新文才會被發現）
    const malformed = results.filter((result) => !result.item && !result.sponsored).length;
    if (items.length === 0 && malformed > 0) {
        throw new Error(`AI News WordPress API returned ${posts.length} posts but none could be parsed`);
    }
    return items;
};
