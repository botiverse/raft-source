export interface SearchRetryReset {
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  results: [];
  searchError: null;
}

export function buildSearchRetryReset(): SearchRetryReset {
  return {
    results: [],
    loading: true,
    loadingMore: false,
    hasMore: false,
    searchError: null,
  };
}
