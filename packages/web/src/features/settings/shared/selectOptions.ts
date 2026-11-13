export type SelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  /** BCP 47 tag of the label's own language (an endonym), for glyphs and screen readers. */
  lang?: string;
};

export function getSelectMenuOptions(
  options: readonly SelectOption[],
  value: string,
  {
    hideSelectedOption = false,
    hiddenOptionValues = [],
  }: {
    hideSelectedOption?: boolean;
    hiddenOptionValues?: readonly string[];
  } = {},
) {
  const hiddenValues = new Set(hiddenOptionValues);
  return options.filter((option) => {
    if (hiddenValues.has(option.value)) return false;
    return !(hideSelectedOption && option.value === value);
  });
}
