// Platform entry point: the search tokenizer (services/searchTokenizer.ts,
// jieba-wasm and its normalization), so an app's queries are split as
// message search splits them, and its own index with the matching index
// side. buildSearchIndexText is the index side (cut_for_search),
// tokenizeSearchText the query side (cut). Only the tokenizer: message search
// itself stays core.
export { buildSearchIndexText, tokenizeSearchText } from "../services/searchTokenizer";
