export function getCommittedSearchQuery(query: string, isComposing: boolean): string | null {
  if (isComposing) {
    return null;
  }

  return query.trim();
}

type SearchKeyboardCompositionEvent = {
  isComposing?: boolean;
  keyCode?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
  };
};

export function isSearchKeyboardComposing(event: SearchKeyboardCompositionEvent): boolean {
  return (
    event.isComposing === true ||
    event.keyCode === 229 ||
    event.nativeEvent?.isComposing === true ||
    event.nativeEvent?.keyCode === 229
  );
}
