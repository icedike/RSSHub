import { load } from 'cheerio';

import type { DataItem } from '@/types';

export const baseUrl = 'https://www.artificialintelligence-news.com';

// 一次取 20 篇：近期平均每天約 1–2 篇，20 篇約涵蓋兩週，中斷幾天後恢復也補得回來
export const API_PAGE_SIZE = 20;

// 「Sponsored Content」分類（業配文，作者多是 SEO 代操公司）：近 100 篇佔 17 篇，不是新聞，不收。
// 先在 API 層排除，分類 id 若哪天變了，toItem 再用分類名稱擋一次
export const SPONSORED_CATEGORY_ID = 3195;
const SPONSORED_NAME = /sponsored/i;

// 全站分類 46 個（2026-10 實測），一頁就取完
const CATEGORY_PAGE_SIZE = 100;

// 錯誤訊息只留回應開頭：夠分辨是驗證頁、轉址頁還是錯誤 JSON，又不會把整頁 HTML 灌進 log
const BODY_SNIPPET_LENGTH = 300;

const NOISE_SELECTORS = ['script', 'style', 'iframe'];

// id（字串）→ 分類名稱；用字串當 key，經過 RSSHub 快取的 JSON 來回後才不會變形
export type CategoryNames = Record<string, string>;

type ResponseMeta = { status: number; contentType: string | null };

// 不嵌入 wp:term：站方的 Yoast SEO 在每個分類／標籤 term 上都附 yoast_head 與 yoast_head_json（每個約 7 KB），
// _fields 管不到嵌入的內容，20 篇會膨脹到 2 MB，站方快取沒命中時容易逾時或回 500/502（2026-10-21 起實測）。
// 作者改讀文章本身的 authors（PublishPress Authors），分類名稱另用 buildCategoriesUrl 查
export const buildApiUrl = (perPage: number = API_PAGE_SIZE): string => {
    const url = new URL(`${baseUrl}/wp-json/wp/v2/posts`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('categories_exclude', String(SPONSORED_CATEGORY_ID));
    url.searchParams.set('_embed', 'wp:featuredmedia');
    url.searchParams.set('_fields', 'id,date_gmt,guid,link,title,content,authors,categories,_links,_embedded');
    return url.toString();
};

export const buildCategoriesUrl = (): string => {
    const url = new URL(`${baseUrl}/wp-json/wp/v2/categories`);
    url.searchParams.set('per_page', String(CATEGORY_PAGE_SIZE));
    url.searchParams.set('_fields', 'id,name');
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

const describeBody = (body: unknown): string => {
    const text = typeof body === 'string' ? body : (JSON.stringify(body) ?? String(body));
    return text.replaceAll(/\s+/g, ' ').trim().slice(0, BODY_SNIPPET_LENGTH);
};

// 站方主機是 SiteGround，懷疑它的反爬會回 2xx 加驗證頁 HTML；ofetch 不把 2xx 當錯誤，HTML 會當字串交進來。
// 錯誤訊息帶狀態碼、content-type 與回應開頭，下次壞掉時從 RSSHub log 就看得出是誰擋的
export function assertPostArray(posts: unknown, response?: ResponseMeta): asserts posts is unknown[] {
    if (!Array.isArray(posts)) {
        const meta = response ? ` (status=${response.status}, content-type=${response.contentType ?? 'none'})` : '';
        throw new TypeError(`AI News WordPress API did not return a post array${meta}: ${describeBody(posts)}`);
    }
}

export const toCategoryNames = (categories: unknown): CategoryNames => {
    if (!Array.isArray(categories)) {
        throw new TypeError(`AI News WordPress API did not return a category array: ${describeBody(categories)}`);
    }
    const names: CategoryNames = Object.fromEntries(categories.filter((category) => Number.isInteger(category?.id) && typeof category?.name === 'string').map((category) => [String(category.id), decodeEntities(category.name)]));
    // 空表也要丟錯：回傳值會被快取一天，空表一旦進快取，整天的文章都不帶分類、業配名稱防線也失效
    if (Object.keys(names).length === 0) {
        throw new Error(`AI News WordPress API returned ${categories.length} categories but no usable categories`);
    }
    return names;
};

// WordPress 的 date_gmt 沒有時區標記（例：2026-10-13T10:00:00），直接 new Date() 會被當本地時間
const parseGmtDate = (value: unknown): Date | undefined => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
        return undefined;
    }
    const date = new Date(`${value}Z`);
    return Number.isNaN(date.getTime()) ? undefined : date;
};

// 作者在 _embedded.author 拿不到名字（回 rest_user_invalid_id），站方用 PublishPress Authors，
// 文章本身的 authors 欄位就有 display_name
const extractAuthor = (authors: unknown): string | undefined => {
    if (!Array.isArray(authors)) {
        return undefined;
    }
    const names = authors
        .map((author) => author?.display_name)
        .filter((name): name is string => typeof name === 'string' && name !== '')
        .map((name) => decodeEntities(name));
    return names.length > 0 ? names.join(', ') : undefined;
};

// 名稱表查不到的 id 直接略過（分類查詢失敗時名稱表是空的，文章照出、只是不帶分類）
const categoryNamesOf = (ids: unknown, categoryNames: CategoryNames): string[] => (Array.isArray(ids) ? ids.map((id) => categoryNames[String(id)]).filter((name): name is string => typeof name === 'string') : []);

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

const toItem = (post: any, categoryNames: CategoryNames): ParseResult => {
    const link = post?.link;
    const title = post?.title?.rendered;
    const pubDate = parseGmtDate(post?.date_gmt);
    const guid = resolveGuid(post);
    if (typeof link !== 'string' || !/^https?:\/\//.test(link) || typeof title !== 'string' || !pubDate || !guid) {
        return {};
    }

    const categories = categoryNamesOf(post.categories, categoryNames);
    if (categories.some((name) => SPONSORED_NAME.test(name))) {
        return { sponsored: true };
    }

    const image = post._embedded?.['wp:featuredmedia']?.[0]?.source_url;
    const content = post.content?.rendered;

    return {
        item: {
            title: decodeEntities(title),
            link,
            guid,
            pubDate,
            description: typeof content === 'string' ? cleanContent(content) : undefined,
            author: extractAuthor(post.authors),
            category: categories.length > 0 ? categories : undefined,
            image: typeof image === 'string' ? image : undefined,
        },
    };
};

export const parseApiPosts = (posts: unknown, categoryNames: CategoryNames): DataItem[] => {
    assertPostArray(posts);
    const results = posts.map((post) => toItem(post, categoryNames));
    const items = results.map((result) => result.item).filter((item): item is DataItem => item !== undefined);
    // API 有回文章、卻因欄位格式不符被全部丟掉 ⇒ 站方改了資料格式。throw 讓 Miniflux 記 parse error、
    // feed-health 點名，不要輸出一個「合法但永遠是空的」feed（那樣要等 7 天無新文才會被發現）
    const malformed = results.filter((result) => !result.item && !result.sponsored).length;
    if (items.length === 0 && malformed > 0) {
        throw new Error(`AI News WordPress API returned ${posts.length} posts but none could be parsed`);
    }
    return items;
};
